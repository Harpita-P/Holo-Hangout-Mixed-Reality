import 'dotenv/config';

type DemoAction = 'on' | 'off' | 'status';

interface DemoStatus {
  enabled: boolean;
  botCount: number;
  realParticipantCount: number;
  totalCount: number;
  capacity: number;
}

const action = process.argv[2] as DemoAction | undefined;
if (action !== 'on' && action !== 'off' && action !== 'status') {
  console.error('Usage: demo-control.ts <on|off|status>');
  process.exitCode = 1;
} else {
  const port = Number.parseInt(process.env.CHATIRL_PORT ?? '8787', 10);
  const url = `http://127.0.0.1:${port}/demo/${action}`;
  try {
    const response = await fetch(url, { method: action === 'status' ? 'GET' : 'POST' });
    const status = (await response.json()) as DemoStatus & { error?: string };
    if (!response.ok) throw new Error(status.error ?? `Request failed (${response.status})`);
    console.log(
      `Demo Mode: ${status.enabled ? 'enabled' : 'disabled'} | ` +
        `bots ${status.botCount} | real viewers ${status.realParticipantCount} | ` +
        `total ${status.totalCount}/${status.capacity}`,
    );
  } catch (error) {
    console.error(
      `Unable to reach the running ChatIRL server at ${url}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  }
}
