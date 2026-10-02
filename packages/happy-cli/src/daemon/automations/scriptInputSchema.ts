import Ajv from 'ajv'

const SCRIPT_INPUT_MAX_BYTES = 65536

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R16 — a script's run input
 * is sealed by the server, not the customer, so the daemon holds it to the input
 * schema in the settings the customer sealed before the code sees it.
 *
 * The same check the server makes before sealing an input (happy-server
 * scriptExecutionService compileScriptInputSchema), with the same options: local
 * references only, no coercion, defaults, removal or network loading. Throws the
 * failure code a run reports.
 */
export function assertScriptInputAdmitted(schema: Record<string, unknown>, input: Record<string, unknown>): void {
  if (Buffer.byteLength(JSON.stringify(input)) > SCRIPT_INPUT_MAX_BYTES) throw new Error('INPUT_TOO_LARGE')
  if (Buffer.byteLength(JSON.stringify(schema)) > SCRIPT_INPUT_MAX_BYTES) throw new Error('INPUT_SCHEMA_INVALID')
  let validate: ReturnType<Ajv['compile']>
  try {
    validate = new Ajv({ strict: true, allErrors: false, ownProperties: true }).compile(schema)
  } catch {
    throw new Error('INPUT_SCHEMA_INVALID')
  }
  if (!validate(input)) throw new Error('INPUT_SCHEMA_INVALID')
}
