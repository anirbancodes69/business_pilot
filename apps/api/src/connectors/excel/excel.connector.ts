import { createHash } from 'node:crypto';
import readExcelFile from 'read-excel-file/node';
import { z } from 'zod';
import {
  type ConnectionTestResult,
  type Connector,
  type ConnectorCallContext,
  type ConnectorCapabilities,
  ConnectorConfigError,
  type DiscoveredField,
  type DiscoveredObject,
  type DiscoveredSchema,
  SchemaError,
  type SourceRow,
} from '../connector';
import { assertSafeXlsx, MAX_UPLOAD_BYTES } from './zip-guard';

const MAX_ROWS = 200_000;
const MAX_COLUMNS = 200;
const MAX_SHEETS = 50;

const configSchema = z.strictObject({ upload_mode: z.literal('manual') });

const CAPABILITIES: ConnectorCapabilities = {
  connector_type: 'excel',
  connector_version: '0.1.0',
  access_modes: ['managed_sync'],
  change_detection: ['row_fingerprint', 'full_snapshot_only'],
  delete_detection: ['fingerprint_diff'],
  schema_discovery: 'header_inference',
  key_strategy: 'user_selected_columns',
  query_pushdown: 'none',
  auth_methods: ['none'],
  prerequisites: [
    'One table per sheet, with column names in the first non-empty row',
    'A column whose values are unique and never empty, to use as the key',
    '.xlsx format (not .xls, .xlsm or .csv)',
  ],
  limits: { max_file_bytes: MAX_UPLOAD_BYTES, max_rows_per_object: MAX_ROWS },
};

type Cell = string | number | boolean | Date | null | undefined;

function isEmpty(cell: Cell): boolean {
  return cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');
}

/** Names come from the first non-empty row. Blanks and duplicates get stable generated names. */
function headerNames(row: Cell[]): string[] {
  const seen = new Map<string, number>();
  return row.map((cell, i) => {
    let base = isEmpty(cell) ? `column_${i + 1}` : String(cell).trim().slice(0, 120);
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    if (count > 1) base = `${base}_${count}`;
    return base;
  });
}

/** Only a type name leaves this function. Cell values are never copied into the result. */
function inferType(values: Cell[]): string {
  const kinds = new Set<string>();
  for (const v of values) {
    if (isEmpty(v)) continue;
    if (typeof v === 'number') kinds.add(Number.isInteger(v) ? 'integer' : 'numeric');
    else if (typeof v === 'boolean') kinds.add('boolean');
    else if (v instanceof Date) kinds.add('date');
    else kinds.add('text');
  }
  if (kinds.size === 0) return 'text';
  if (kinds.size === 1) return [...kinds][0] as string;
  if (kinds.size === 2 && kinds.has('integer') && kinds.has('numeric')) return 'numeric';
  return 'text';
}

/** The header names and the non-empty body rows of a sheet, or null for an empty sheet. */
function tableOf(rows: Cell[][]): { names: string[]; body: Cell[][] } | null {
  const start = rows.findIndex((r) => r.some((c) => !isEmpty(c)));
  if (start < 0) return null;
  const headerRow = rows[start] as Cell[];
  let width = headerRow.length;
  while (width > 0 && isEmpty(headerRow[width - 1])) width--;
  if (width === 0) return null;
  if (width > MAX_COLUMNS) throw new SchemaError('a sheet has too many columns');
  const names = headerNames(headerRow.slice(0, width));
  const body = rows.slice(start + 1).filter((r) => r.some((c) => !isEmpty(c)));
  if (body.length > MAX_ROWS) throw new SchemaError('a sheet has too many rows');
  return { names, body };
}

function describeSheet(name: string, rows: Cell[][]): DiscoveredObject | null {
  const table = tableOf(rows);
  if (!table) return null;
  const { names, body } = table;

  const fields: DiscoveredField[] = [];
  const keyCandidates: string[] = [];
  names.forEach((fieldName, col) => {
    const values = body.map((r) => r[col]);
    const nullable = values.some(isEmpty);
    fields.push({
      name: fieldName,
      data_type: inferType(values),
      nullable,
      is_primary_key: false,
    });
    // A key must be present and unique in every row. Comparison is on a normalized string.
    if (!nullable && body.length > 0) {
      const keys = new Set(values.map((v) => (v instanceof Date ? v.toISOString() : String(v))));
      if (keys.size === values.length) keyCandidates.push(fieldName);
    }
  });
  // For a file the row count is exact, not a planner estimate.
  return {
    name: name.slice(0, 120),
    kind: 'sheet',
    fields,
    estimated_rows: body.length,
    key_candidates: keyCandidates,
  };
}

export class ExcelConnector implements Connector {
  readonly type = 'excel';

  describeCapabilities(): ConnectorCapabilities {
    return CAPABILITIES;
  }

  parseConfig(config: unknown): z.infer<typeof configSchema> {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success)
      throw new ConnectorConfigError(
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
      );
    return parsed.data;
  }

  /** Uploads have no credentials. */
  parseCredentials(credentials: unknown): undefined {
    if (credentials !== undefined) throw new ConnectorConfigError(['credentials: unexpected']);
    return undefined;
  }

  private async load(ctx: ConnectorCallContext): Promise<Buffer | undefined> {
    this.parseConfig(ctx.config);
    return ctx.readUpload?.();
  }

  async testConnection(ctx: ConnectorCallContext): Promise<ConnectionTestResult> {
    const file = await this.load(ctx);
    if (!file) return { ok: false, errors: ['no file has been uploaded'], privilege_warnings: [] };
    try {
      assertSafeXlsx(file);
    } catch (error) {
      if (error instanceof SchemaError)
        return { ok: false, errors: [error.message], privilege_warnings: [] };
      throw error;
    }
    return { ok: true, errors: [], privilege_warnings: [] };
  }

  private async sheets(ctx: ConnectorCallContext): Promise<{ sheet: string; data: Cell[][] }[]> {
    const file = await this.load(ctx);
    if (!file) throw new SchemaError('no file has been uploaded');
    assertSafeXlsx(file);
    let sheets: { sheet: string; data: Cell[][] }[];
    try {
      sheets = (await readExcelFile(file)) as { sheet: string; data: Cell[][] }[];
    } catch {
      // Parser messages can quote cell content, so only a fixed message is passed on.
      throw new SchemaError('the workbook could not be read');
    }
    if (sheets.length > MAX_SHEETS) throw new SchemaError('the workbook has too many sheets');
    return sheets;
  }

  async readSnapshot(
    ctx: ConnectorCallContext,
    object: string,
    columns: string[],
    batchSize: number,
    onBatch: (rows: SourceRow[]) => Promise<void>,
  ): Promise<void> {
    const sheet = (await this.sheets(ctx)).find((s) => s.sheet.slice(0, 120) === object);
    const table = sheet ? tableOf(sheet.data) : null;
    if (!table) throw new SchemaError('the object is no longer in the file');
    const index = columns.map((c) => table.names.indexOf(c));
    if (index.some((i) => i < 0)) throw new SchemaError('a mapped column is no longer in the file');
    for (let at = 0; at < table.body.length; at += batchSize) {
      const rows = table.body.slice(at, at + batchSize).map((r) => {
        const row: SourceRow = {};
        columns.forEach((c, k) => {
          row[c] = r[index[k] as number];
        });
        return row;
      });
      await onBatch(rows);
    }
  }

  async discoverSchema(ctx: ConnectorCallContext): Promise<DiscoveredSchema> {
    const sheets = await this.sheets(ctx);
    const objects = sheets
      .map((s) => describeSheet(s.sheet, s.data))
      .filter((o): o is DiscoveredObject => o !== null);
    const canonical = objects.map((o) => [o.name, o.fields.map((f) => [f.name, f.data_type])]);
    return {
      objects,
      fingerprint: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    };
  }
}
