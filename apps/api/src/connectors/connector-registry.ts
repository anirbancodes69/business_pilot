import { Inject, Injectable } from '@nestjs/common';
import { Env_TOKEN } from '../platform/config/config.module';
import type { Env } from '../platform/config/env';
import { type Connector, type ConnectorCapabilities, capabilitiesSchema } from './connector';
import { ExcelConnector } from './excel/excel.connector';
import { PostgresConnector } from './postgresql/postgresql.connector';

/** Core code asks the registry by type and reads capabilities. It never branches on the type. */
@Injectable()
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  constructor(@Inject(Env_TOKEN) env: Env) {
    this.register(
      new PostgresConnector({ allowPrivateNetworks: env.CONNECTOR_ALLOW_PRIVATE_NETWORKS }),
    );
    this.register(new ExcelConnector());
  }

  register(connector: Connector): void {
    const capabilities = capabilitiesSchema.parse(connector.describeCapabilities());
    if (capabilities.connector_type !== connector.type)
      throw new Error(`connector ${connector.type} publishes a different capability type`);
    if (this.connectors.has(connector.type))
      throw new Error(`connector ${connector.type} is already registered`);
    this.connectors.set(connector.type, connector);
  }

  get(type: string): Connector | undefined {
    return this.connectors.get(type);
  }

  list(): ConnectorCapabilities[] {
    return [...this.connectors.values()].map((c) => c.describeCapabilities());
  }
}
