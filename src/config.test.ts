import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const ORIGINAL_ENV = { ...process.env };

async function freshConfigModule(): Promise<typeof import('./config.js')> {
  return import(`./config.js?test=${Date.now()}-${Math.random()}`);
}

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV };
}

function setBaseEnv(): void {
  resetEnv();
  process.env.DOTENV_OVERRIDE = 'false';
  process.env.TELEGRAM_BOT_TOKEN = 'token';
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = '123';
}

afterEach(resetEnv);

describe('config loading', () => {
  it('parses false-like boolean env values as false', async () => {
    setBaseEnv();
    process.env.TELEGRAM_GROUP_REQUIRE_MENTION = 'false';
    process.env.TELEGRAM_ENABLE_REACTIONS = 'false';
    process.env.TELEGRAM_ENABLE_TYPING = 'false';
    process.env.VERBOSE_EVENTS = 'false';
    process.env.SHOW_CONTROL_BUTTONS = 'false';

    const { loadConfig } = await freshConfigModule();
    const config = loadConfig();

    assert.equal(config.TELEGRAM_GROUP_REQUIRE_MENTION, false);
    assert.equal(config.TELEGRAM_ENABLE_REACTIONS, false);
    assert.equal(config.TELEGRAM_ENABLE_TYPING, false);
    assert.equal(config.VERBOSE_EVENTS, false);
    assert.equal(config.SHOW_CONTROL_BUTTONS, false);
  });

  it('parses true-like boolean env values as true', async () => {
    setBaseEnv();
    process.env.TELEGRAM_ENABLE_REACTIONS = 'yes';
    process.env.SHOW_CONTROL_BUTTONS = '1';

    const { loadConfig } = await freshConfigModule();
    const config = loadConfig();

    assert.equal(config.TELEGRAM_ENABLE_REACTIONS, true);
    assert.equal(config.SHOW_CONTROL_BUTTONS, true);
  });

  it('builds pi args from provider/model/thinking/session dir', async () => {
    setBaseEnv();
    process.env.PI_PROVIDER = 'cliproxyapi';
    process.env.PI_MODEL = 'gpt-5.5';
    process.env.PI_THINKING = 'high';
    process.env.PI_SESSION_DIR = '/tmp/pi sessions';

    const { loadConfig } = await freshConfigModule();
    const config = loadConfig();

    assert.deepEqual(config.piArgs, ['--provider', 'cliproxyapi', '--model', 'gpt-5.5', '--thinking', 'high', '--session-dir', '/tmp/pi sessions']);
  });
});
