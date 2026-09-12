// A bounded CI gate: process success requires the app's HTTP/WS assertions, not
// merely a successful compile or launch. No dependency on UI automation tools.
const until = Date.now() + 180000;
(async () => {
  while (Date.now() < until) {
    let result;
    try {
      const response = await fetch('http://127.0.0.1:18081/result', { signal: AbortSignal.timeout(3000) });
      if (response.status === 200) result = await response.json();
    } catch { /* fixture starting */ }
    if (result) {
      console.log(JSON.stringify(result, null, 2));
      if (result.ok !== true || !Array.isArray(result.completed) || result.completed.length !== 7) process.exit(1);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Native E2E did not report a result within 180 seconds');
})().catch(error => { console.error(error.message); process.exit(1); });