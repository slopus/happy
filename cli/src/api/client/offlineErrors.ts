import axios from 'axios';
import chalk from 'chalk';

import { connectionState, isNetworkError } from '@/api/offline/serverConnectionErrors';

export function shouldReturnNullForGetOrCreateSessionError(
  error: unknown,
  params: Readonly<{ url: string }>
): boolean {
  // Check if it's a connection error
  if (error && typeof error === 'object' && 'code' in error) {
    const errorCode = (error as any).code;
    if (isNetworkError(errorCode)) {
      connectionState.fail({
        operation: 'Session creation',
        caller: 'api.getOrCreateSession',
        errorCode,
        url: params.url,
      });
      return true;
    }
  }

  // Handle 404 gracefully - server endpoint may not be available yet
  const is404Error =
    (axios.isAxiosError(error) && error.response?.status === 404) ||
    (error && typeof error === 'object' && 'response' in error && (error as any).response?.status === 404);
  if (is404Error) {
    connectionState.fail({
      operation: 'Session creation',
      errorCode: '404',
      url: params.url,
    });
    return true;
  }

  // Handle 5xx server errors - use offline mode with auto-reconnect
  if (axios.isAxiosError(error) && error.response?.status) {
    const status = error.response.status;
    if (status >= 500) {
      connectionState.fail({
        operation: 'Session creation',
        errorCode: String(status),
        url: params.url,
        details: ['Server encountered an error, will retry automatically'],
      });
      return true;
    }
  }

  return false;
}

export function shouldReturnMinimalMachineForGetOrCreateMachineError(
  error: unknown,
  params: Readonly<{ url: string }>
): boolean {
  // Handle connection errors gracefully
  if (axios.isAxiosError(error) && error.code && isNetworkError(error.code)) {
    connectionState.fail({
      operation: 'Machine registration',
      caller: 'api.getOrCreateMachine',
      errorCode: error.code,
      url: params.url,
    });
    return true;
  }

  // Handle 403/409 - server rejected request due to authorization conflict
  // This is NOT "server unreachable" - server responded, so don't use connectionState
  if (axios.isAxiosError(error) && error.response?.status) {
    const status = error.response.status;

    if (status === 403 || status === 409) {
      // Re-auth conflict: machine registered to old account, re-association not allowed
      console.log(chalk.yellow(`⚠️  Machine registration rejected by the server with status ${status}`));
      console.log(chalk.yellow(`   → This machine ID is already registered to another account on the server`));
      console.log(chalk.yellow(`   → This usually happens after re-authenticating with a different account`));
      console.log(chalk.yellow(`   → Run 'happy doctor clean' to reset local state and generate a new machine ID`));
      console.log(chalk.yellow(`   → Open a GitHub issue if this problem persists`));
      return true;
    }

    // Handle 5xx - server error, use offline mode with auto-reconnect
    if (status >= 500) {
      connectionState.fail({
        operation: 'Machine registration',
        errorCode: String(status),
        url: params.url,
        details: ['Server encountered an error, will retry automatically'],
      });
      return true;
    }

    // Handle 404 - endpoint may not be available yet
    if (status === 404) {
      connectionState.fail({
        operation: 'Machine registration',
        errorCode: '404',
        url: params.url,
      });
      return true;
    }
  }

  return false;
}
