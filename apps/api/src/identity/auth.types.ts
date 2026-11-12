import type { Request } from 'express';
import type { AuthorizationContext } from '../authorization/authorization';

export interface AuthedRequest extends Request {
  user?: { id: string };
  /** Present on tenant routes only. Derived from verified membership, never from client input. */
  auth?: { userId: string; tenantId: string; membershipId: string; authz: AuthorizationContext };
}
