import { createComputerUpdates } from "@rakazo/core";
import { rpc } from "./rpc";
export const computerUpdates = createComputerUpdates({
  list: () => rpc.computer.updates(),
  start: (botId, action) => rpc.computer[action]({ botId }),
  dismiss: (id) => rpc.computer.dismissUpdate({ id }),
});
