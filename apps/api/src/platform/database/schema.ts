import type { ColumnType, Generated } from 'kysely';

// Hand-maintained table types for schema `core` (ADR-0009: the generation method is still open).
// Kept in sync with src/migrations; the isolation tests catch drift between code and database.

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string | undefined, string>;

export interface TenantTable {
  id: Generated<string>;
  name: string;
  slug: string;
  status: Generated<'provisioning' | 'active' | 'suspended' | 'deleting' | 'deleted'>;
  region: string | null;
  plan: string | null;
  template_id: string | null;
  key_id: string | null;
  wrapped_data_key: Buffer | null;
  created_at: Generated<Date>;
}

export interface AppUserTable {
  id: Generated<string>;
  idp_subject: string;
  email: string | null;
  display_name: string | null;
  status: Generated<'active' | 'disabled'>;
  created_at: Generated<Date>;
}

export interface PermissionTable {
  key: string;
  description: string;
}

export interface RoleTable {
  id: Generated<string>;
  tenant_id: string | null;
  key: string;
  name: string;
}

export interface RolePermissionTable {
  tenant_id: string | null;
  role_id: string;
  permission_key: string;
}

export interface TenantMembershipTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  status: Generated<'invited' | 'active' | 'suspended'>;
  attributes: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Generated<Date>;
}

export interface MembershipRoleTable {
  tenant_id: string;
  membership_id: string;
  role_id: string;
}

export interface AccessPolicyTable {
  id: Generated<string>;
  tenant_id: string;
  version: number;
  document: Json;
  status: Generated<'draft' | 'active' | 'retired'>;
  created_at: Ts;
}

export interface AuditEventTable {
  id: Generated<string>;
  tenant_id: string;
  actor_id: string | null;
  action: string;
  target: string | null;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  occurred_at: Generated<Date>;
}

export interface SemanticModelTable {
  id: Generated<string>;
  tenant_id: string;
  version: number;
  status: Generated<'draft' | 'published' | 'retired'>;
  document: Json;
  created_by: string | null;
  created_at: Generated<Date>;
  published_by: string | null;
  published_at: ColumnType<Date | null, Date | string | undefined, Date | string | null>;
}

export interface ConnectorCredentialTable {
  id: Generated<string>;
  tenant_id: string;
  key_id: string;
  ciphertext: Buffer;
  created_at: Generated<Date>;
}

export interface DataSourceTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  type: string;
  access_mode: 'managed_sync' | 'live_federated';
  connection: Json;
  credential_id: string | null;
  status: Generated<'draft' | 'connected' | 'error' | 'disabled'>;
  last_tested_at: ColumnType<Date | null, Date | string | undefined, Date | string | null>;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface DataSourceUploadTable {
  id: Generated<string>;
  tenant_id: string;
  data_source_id: string;
  object_key: string;
  file_name: string;
  size_bytes: ColumnType<string, number, never>;
  sha256: string;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface DataSourceObjectTable {
  id: Generated<string>;
  tenant_id: string;
  data_source_id: string;
  name: string;
  key_columns: ColumnType<string[], string | undefined, string>;
  approved: Generated<boolean>;
  approved_by: string | null;
  approved_at: ColumnType<Date | null, Date | string | undefined, Date | string | null>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface EntityMappingTable {
  id: Generated<string>;
  tenant_id: string;
  data_source_id: string;
  source_object: string;
  canonical_entity: string;
  status: Generated<
    'suggested' | 'in_review' | 'approved' | 'active' | 'rejected' | 'needs_review' | 'superseded'
  >;
  document: Json;
  confidence: ColumnType<string | null, number | null | undefined, number | null>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
  approved_by: string | null;
  approved_at: ColumnType<Date | null, Date | string | undefined, Date | string | null>;
  activated_by: string | null;
  activated_at: ColumnType<Date | null, Date | string | undefined, Date | string | null>;
}

export interface SyncRunTable {
  id: Generated<string>;
  tenant_id: string;
  data_source_id: string;
  status: Generated<'queued' | 'running' | 'succeeded' | 'partially_failed' | 'failed' | 'paused'>;
  trigger: 'manual' | 'schedule' | 'upload' | 'activation';
  started_at: Generated<Date>;
  finished_at: ColumnType<Date | null, Date | string | undefined, Date | string | null>;
  stats: Json;
  error_code: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface SyncCheckpointTable {
  tenant_id: string;
  data_source_id: string;
  source_object: string;
  cursor: Json;
  schema_fingerprint: string | null;
  last_run_id: string | null;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface DatasetTable {
  tenant_id: string;
  data_source_id: string;
  canonical_entity: string;
  data_version: ColumnType<string, string | number | undefined, string | number>;
  bumped_run_id: string | null;
  status: Generated<'never_synced' | 'fresh' | 'failed' | 'paused'>;
  last_attempt_at: ColumnType<Date | null, Date | string | undefined, Date | string | null>;
  last_successful_sync_at: ColumnType<Date | null, Date | string | undefined, Date | string | null>;
  row_count: ColumnType<string | null, string | number | null | undefined, string | number | null>;
}

export interface SyncDeadLetterTable {
  id: Generated<string>;
  tenant_id: string;
  run_id: string;
  data_source_id: string;
  source_object: string;
  source_key: string | null;
  field: string | null;
  error_code: string;
  created_at: Generated<Date>;
}

export interface OutboxEventTable {
  id: Generated<string>;
  tenant_id: string;
  type: string;
  aggregate_ref: string;
  payload: Json;
  created_at: Generated<Date>;
  published_at: ColumnType<Date | null, Date | string | undefined, Date | string | null>;
}

export interface Database {
  'core.tenant': TenantTable;
  'core.app_user': AppUserTable;
  'core.permission': PermissionTable;
  'core.role': RoleTable;
  'core.role_permission': RolePermissionTable;
  'core.tenant_membership': TenantMembershipTable;
  'core.membership_role': MembershipRoleTable;
  'core.access_policy': AccessPolicyTable;
  'core.audit_event': AuditEventTable;
  'core.semantic_model': SemanticModelTable;
  'core.connector_credential': ConnectorCredentialTable;
  'core.data_source': DataSourceTable;
  'core.data_source_upload': DataSourceUploadTable;
  'core.data_source_object': DataSourceObjectTable;
  'core.entity_mapping': EntityMappingTable;
  'core.sync_run': SyncRunTable;
  'core.sync_checkpoint': SyncCheckpointTable;
  'core.dataset': DatasetTable;
  'core.sync_dead_letter': SyncDeadLetterTable;
  'core.outbox_event': OutboxEventTable;
}
