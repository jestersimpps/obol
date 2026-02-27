const inquirer = require('inquirer');

async function waitForProject(token, projectId, maxWait = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const remaining = Math.ceil((maxWait - (Date.now() - start)) / 1000);
    process.stdout.write(`\r  Waiting... ${elapsed}s elapsed, ~${remaining}s remaining`);
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const project = await res.json();
    if (project.status === 'ACTIVE_HEALTHY') {
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      return;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  process.stdout.write('\n');
  throw new Error('Project creation timed out');
}

async function setupSupabaseNew() {
  console.log('\n  An access token lets OBOL create and manage a Supabase project for you.\n');
  console.log('  How to get it:');
  console.log('    1. Go to https://supabase.com/dashboard/account/tokens');
  console.log('    2. Click "Generate new token"');
  console.log('    3. Name it "obol" and copy the token\n');
  const { accessToken } = await inquirer.prompt([{
    type: 'password',
    name: 'accessToken',
    message: 'Supabase access token:',
    mask: '*',
  }]);

  const { region } = await inquirer.prompt([{
    type: 'list',
    name: 'region',
    message: 'Supabase region (pick closest to your server):',
    choices: [
      { name: 'US East (Virginia)', value: 'us-east-1' },
      { name: 'US West (Oregon)', value: 'us-west-1' },
      { name: 'EU Central (Frankfurt)', value: 'eu-central-1' },
      { name: 'EU West (London)', value: 'eu-west-2' },
      { name: 'AP Southeast (Singapore)', value: 'ap-southeast-1' },
      { name: 'AP Northeast (Tokyo)', value: 'ap-northeast-1' },
      { name: 'AP South (Mumbai)', value: 'ap-south-1' },
      { name: 'SA East (Sao Paulo)', value: 'sa-east-1' },
    ],
  }]);

  console.log('  Creating project...');
  try {
    const dbPass = require('crypto').randomBytes(16).toString('hex');

    const res = await fetch('https://api.supabase.com/v1/projects', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'obol',
        region,
        plan: 'free',
        db_pass: dbPass,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    const project = await res.json();
    console.log(`  ✅ Project created: ${project.id}`);

    console.log('  Waiting for project to initialize (this takes ~60s)...');
    await waitForProject(accessToken, project.id);

    const keysRes = await fetch(`https://api.supabase.com/v1/projects/${project.id}/api-keys`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const keys = await keysRes.json();
    const serviceKey = keys.find(k => k.name === 'service_role')?.api_key;
    const anonKey = keys.find(k => k.name === 'anon')?.api_key;
    const url = `https://${project.id}.supabase.co`;

    console.log(`  ✅ Project ready: ${url}\n`);

    return { url, serviceKey, anonKey, accessToken };
  } catch (e) {
    console.error(`  ❌ Failed: ${e.message}`);
    console.log('  Falling back to manual setup...\n');
    return await setupSupabaseExisting();
  }
}

async function setupSupabaseExisting() {
  console.log('\n  You need three things from your Supabase project:\n');
  console.log('  1. Project ID (or full URL)');
  console.log('     - Go to your project dashboard');
  console.log('     - The ID is in the URL: supabase.com/dashboard/project/<THIS PART>');
  console.log('     - Or use the full URL: https://xxx.supabase.co\n');
  console.log('  2. Service role key');
  console.log('     - Go to: Project Settings > Data API (or API)');
  console.log('     - Under "Project API keys", find the "service_role" key');
  console.log('     - It says "This key has the ability to bypass Row Level Security"');
  console.log('     - Click to reveal and copy it\n');
  console.log('  3. Access token (needed to run database migrations)');
  console.log('     - Go to: https://supabase.com/dashboard/account/tokens');
  console.log('     - Click "Generate new token", name it "obol"');
  console.log('     - Copy the token\n');
  const { projectRef } = await inquirer.prompt([{
    type: 'input',
    name: 'projectRef',
    message: 'Supabase project URL or project ID:',
    validate: (v) => (v.includes('supabase.co') || /^[a-z]{20,}$/.test(v.trim())) ? true : 'Enter https://xxx.supabase.co or a project ID (lowercase letters, 20+ chars)',
  }]);

  const ref = projectRef.trim();
  const url = ref.includes('supabase.co') ? ref.replace(/\/+$/, '') : `https://${ref}.supabase.co`;

  const { serviceKey } = await inquirer.prompt([{
    type: 'password',
    name: 'serviceKey',
    message: 'Service role key:',
    mask: '*',
  }]);

  const { accessToken } = await inquirer.prompt([{
    type: 'password',
    name: 'accessToken',
    message: 'Supabase access token:',
    mask: '*',
  }]);

  console.log('  ✅ Supabase configured\n');
  return { url, serviceKey, accessToken };
}

module.exports = { setupSupabaseNew, setupSupabaseExisting, waitForProject };
