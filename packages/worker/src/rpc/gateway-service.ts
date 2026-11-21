// SPDX-License-Identifier: Apache-2.0
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { GitGateway, RpcInput, RpcOutput } from '@leed-ai/git-gateway-contract/git-gateway';

import type { GatewayOptions } from './gateway-context.ts';
import { createGatewayRpc } from './gateway-rpc.ts';

/** Builds a deployment's {@link GatewayOptions} from its Worker environment (bindings and secrets). */
export type GatewayOptionsResolver<Env> = (env: Env) => GatewayOptions;

/** The RPC entrypoint class {@link createGatewayService} returns. */
export type GatewayServiceClass<Env> = new (
  ctx: ExecutionContext,
  env: Env,
) => WorkerEntrypoint<Env> & GitGateway;

/**
 * The git-gateway RPC API as a `WorkerEntrypoint`, for other Workers to call over a service
 * binding. A deployment exports the returned class under a name of its choosing and binds it:
 *
 *   export const GatewayService = createGatewayService((env: Env) => ({
 *     backend: new ArtifactsBackend(env.ARTIFACTS),
 *     readTokenSecret: env.READ_TOKEN_SECRET,
 *     commitWorkflow: env.COMMIT_WORKFLOW,
 *   }));
 *
 * Every method validates its input and output with the contract schemas. Errors are
 * GatewayErrors, whose message carries the error body so callers recover it with
 * `readGatewayError` on the far side of the binding. The options (and the secret in them) live in
 * a closure, never on the class, so no RPC call can reach them.
 */
export function createGatewayService<Env>(resolve: GatewayOptionsResolver<Env>): GatewayServiceClass<Env> {
  return class GatewayService extends WorkerEntrypoint<Env> implements GitGateway {
    #gateway: GitGateway | undefined;

    #rpc(): GitGateway {
      this.#gateway ??= createGatewayRpc(resolve(this.env));
      return this.#gateway;
    }

    async commit(input: RpcInput<'commit'>): Promise<RpcOutput<'commit'>> {
      return await this.#rpc().commit(input);
    }

    async readFile(input: RpcInput<'readFile'>): Promise<RpcOutput<'readFile'>> {
      return await this.#rpc().readFile(input);
    }

    async listTree(input: RpcInput<'listTree'>): Promise<RpcOutput<'listTree'>> {
      return await this.#rpc().listTree(input);
    }

    async resolveRef(input: RpcInput<'resolveRef'>): Promise<RpcOutput<'resolveRef'>> {
      return await this.#rpc().resolveRef(input);
    }

    async log(input: RpcInput<'log'>): Promise<RpcOutput<'log'>> {
      return await this.#rpc().log(input);
    }

    async commitExists(input: RpcInput<'commitExists'>): Promise<RpcOutput<'commitExists'>> {
      return await this.#rpc().commitExists(input);
    }

    async syncBranch(input: RpcInput<'syncBranch'>): Promise<RpcOutput<'syncBranch'>> {
      return await this.#rpc().syncBranch(input);
    }

    async promote(input: RpcInput<'promote'>): Promise<RpcOutput<'promote'>> {
      return await this.#rpc().promote(input);
    }

    async createRepo(input: RpcInput<'createRepo'>): Promise<RpcOutput<'createRepo'>> {
      return await this.#rpc().createRepo(input);
    }

    async deleteRepo(input: RpcInput<'deleteRepo'>): Promise<RpcOutput<'deleteRepo'>> {
      return await this.#rpc().deleteRepo(input);
    }

    async mintReadToken(input: RpcInput<'mintReadToken'>): Promise<RpcOutput<'mintReadToken'>> {
      return await this.#rpc().mintReadToken(input);
    }
  };
}
