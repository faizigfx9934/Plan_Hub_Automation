export const logger = {
  ok: (msg) => console.log(`✅ ${msg}`),
  fail: (msg) => console.log(`❌ ${msg}`),
  info: (msg) => console.log(`ℹ️  ${msg}`),
  step: (msg) => console.log(`\n━━━ ${msg} ━━━`),
};
