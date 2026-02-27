const inquirer = require('inquirer');
const open = require('open');
const { generatePKCE, buildAuthorizationUrl, exchangeCodeForTokens } = require('../auth/oauth');
const { validateAnthropic } = require('../auth/validators');
const { validateCredential, promptApiKey } = require('./init-utils');

async function setupAnthropicOAuth() {
  console.log('\n  This will open your browser to sign in with your Anthropic account.\n');

  const { verifier, challenge } = await generatePKCE();
  const authUrl = buildAuthorizationUrl(challenge, verifier);

  console.log('  Opening browser...\n');
  try {
    await open(authUrl);
  } catch {
    console.log('  Could not open browser automatically.');
  }
  console.log(`  If the browser didn't open, go to:\n  ${authUrl}\n`);
  console.log('  After signing in, you\'ll see a page with a code.');
  console.log('  The URL will look like: ...callback?code=XXXXX#STATE\n');

  const { callbackInput } = await inquirer.prompt([{
    type: 'input',
    name: 'callbackInput',
    message: 'Paste the full callback URL or just the code:',
    validate: (v) => v.trim().length > 0 ? true : 'Required',
  }]);

  const input = callbackInput.trim();

  if (input.includes('sk-ant-oat')) {
    console.log('  That\'s a raw token, not a callback URL.');
    console.log('  Paste the full URL from your browser after authorizing.\n');
    return await setupAnthropicOAuth();
  }

  let code, state;

  if (input.includes('code=')) {
    const url = new URL(input);
    code = url.searchParams.get('code');
    state = url.hash?.replace('#', '') || verifier;
  } else if (input.includes('#')) {
    [code, state] = input.split('#');
  } else {
    code = input;
    state = verifier;
  }

  process.stdout.write('  Exchanging code for tokens...');
  try {
    const tokens = await exchangeCodeForTokens(code, state, verifier);
    console.log(' ✅ Authenticated');
    console.log(`  Access token expires: ${new Date(tokens.expires).toLocaleString()}\n`);
    return {
      oauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expires: tokens.expires,
      },
    };
  } catch (e) {
    console.log(` ❌ ${e.message}`);
    console.log('\n  Falling back to API key...\n');
    const { anthropicKey } = await inquirer.prompt([{
      type: 'password',
      name: 'anthropicKey',
      message: 'Anthropic API key:',
      mask: '*',
      validate: (v) => v.startsWith('sk-ant-') ? true : 'Should start with sk-ant-',
    }]);
    await validateCredential('Anthropic', () => validateAnthropic(anthropicKey));
    return { apiKey: anthropicKey };
  }
}

async function runOAuthFlow(cfg, setNestedValue, saveConfig) {
  console.log('\n  Starting OAuth flow with Anthropic...\n');

  const { verifier, challenge } = await generatePKCE();
  const authUrl = buildAuthorizationUrl(challenge, verifier);

  console.log('  1. Open this URL in your browser:\n');
  console.log(`  ${authUrl}\n`);
  console.log('  2. Authorize the app, then copy the FULL redirect URL from your browser.\n');
  console.log('     It will look like: https://console.anthropic.com/oauth/code/callback?code=XXXXX#STATE\n');

  const { callbackInput } = await inquirer.prompt([{
    type: 'input',
    name: 'callbackInput',
    message: 'Paste the full callback URL or just the code:',
    validate: (v) => v.trim().length > 0 ? true : 'Required',
  }]);

  try {
    const input = callbackInput.trim();
    let code, state;

    if (input.includes('code=')) {
      const url = new URL(input);
      code = url.searchParams.get('code');
      state = url.hash?.replace('#', '') || verifier;
    } else if (input.includes('#')) {
      [code, state] = input.split('#');
    } else {
      code = input;
      state = verifier;
    }

    if (!code) {
      console.log('  No code found\n');
      return;
    }

    console.log('  Exchanging code for tokens...');
    const tokens = await exchangeCodeForTokens(code, state, verifier);

    setNestedValue(cfg, 'anthropic.oauth.accessToken', tokens.accessToken);
    setNestedValue(cfg, 'anthropic.oauth.refreshToken', tokens.refreshToken);
    setNestedValue(cfg, 'anthropic.oauth.expires', tokens.expires);
    saveConfig(cfg);

    console.log('  OAuth configured with access + refresh token');
    console.log(`  Token expires: ${new Date(tokens.expires).toISOString()}\n`);
  } catch (e) {
    console.log(`  OAuth flow failed: ${e.message}\n`);
  }
}

module.exports = { setupAnthropicOAuth, runOAuthFlow };
