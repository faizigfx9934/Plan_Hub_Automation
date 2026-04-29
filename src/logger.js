let currentContext = 'Idle';

export const logger = {
  ok: (msg) => console.log(`✅ ${msg}`),
  fail: (msg) => console.log(`❌ ${msg}`),
  info: (msg) => console.log(`ℹ️  ${msg}`),
  step: (msg) => {
    currentContext = msg;
    console.log(`\n━━━ ${msg} ━━━`);
  },
  setContext: (ctx) => { currentContext = ctx; },
  getContext: () => currentContext,
};
