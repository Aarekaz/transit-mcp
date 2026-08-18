import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { SupportedCity } from '../transit/base';
import type { Env } from '../types';

const metroMcpPropsSchema = z.strictObject({
  userId: z.string().trim().min(1),
  userLogin: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  scopes: z.tuple([z.literal('transit:read')]),
});

export interface MetroMcpProps extends Record<string, unknown> {
  userId: string;
  userLogin: string;
  clientId: string;
  scopes: ['transit:read'];
}

export interface MetroMcpContext {
  env: Env;
  era: 'modern' | 'legacy';
  authInfo?: AuthInfo;
  props: MetroMcpProps;
}

export type MetroRequestState = {
  phase: 'station-selection';
  tool: 'get_station_predictions';
  city: SupportedCity;
  query: string;
  candidateIds: string[];
};

/** Parse OAuth application props into the only shape accepted by Metro MCP. */
export function parseMetroMcpProps(value: unknown): MetroMcpProps {
  const result = metroMcpPropsSchema.safeParse(value);
  if (!result.success) {
    throw new Error('Invalid OAuth props');
  }

  return result.data;
}

/** Enforce Metro MCP's single application permission before building a server. */
export function requireTransitRead<Props>(props: Props): Props {
  const scopes = typeof props === 'object'
    && props !== null
    && !Array.isArray(props)
    && 'scopes' in props
    ? props.scopes
    : undefined;

  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== 'transit:read') {
    throw new OAuthError(OAuthErrorCode.InsufficientScope, 'insufficient_scope');
  }

  return props;
}
