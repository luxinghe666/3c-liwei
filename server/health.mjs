const origin = new URL(process.env.APP_ORIGIN);
const response = await fetch(`http://127.0.0.1:${process.env.PORT || 4318}/api/session`, {
  headers: {Host: origin.host}, signal: AbortSignal.timeout(3000),
});
if (!response.ok || typeof (await response.json()).initialized !== 'boolean') process.exitCode=1;
