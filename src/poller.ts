import fs from 'node:fs/promises';
import { execFile, type ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_REPOS } from './repos.ts';
import { buildReviewPrompt } from './prompts.ts';

const execFileAsync = promisify(execFile);

// ---------- Config ----------

const OWNER = process.env.GITHUB_OWNER;
const TOKEN = process.env.GITHUB_TOKEN;
const INTERVAL = Number(process.env.POLL_INTERVAL_MS) || 60_000;
const DRY = process.env.DRY_RUN === 'true';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 90_000;
const GIF_THEME = process.env.GIF_THEME || 'lgtm celebration ship-it';
const GIF_PROBABILITY = Number(process.env.GIF_PROBABILITY ?? 0.2);
const MAX_GIF_ROUNDS = Number(process.env.GIF_MAX_ROUNDS) || 3;
const STATE_FILE = new URL('../state.json', import.meta.url);
const MAX_GIF_BYTES = 5 * 1024 * 1024;

const REPOS = (process.env.GITHUB_REPOS
  ? process.env.GITHUB_REPOS.split(',')
  : DEFAULT_REPOS
)
  .map((r) => r.trim())
  .filter(Boolean);

// If set (comma-separated GitHub usernames), only act on PRs by these authors.
// Empty/unset = act on every author (current default).
const ALLOWED_AUTHORS = new Set(
  (process.env.ALLOWED_AUTHORS || '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean),
);

if (!OWNER || !TOKEN) {
  console.error('GITHUB_OWNER and GITHUB_TOKEN env vars are required.');
  process.exit(1);
}

const API = 'https://api.github.com';
const headers: Record<string, string> = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'pr-autoapprover',
};

// ---------- Types ----------

type ReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

interface Issue {
  path: string;
  line: number;
  body: string;
  suggestion: string;
}

interface InlineComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

interface ClaudeResult {
  summary: string;
  issues: Issue[];
  urls: string[];
}

interface PrSummary {
  number: number;
  title?: string;
  user?: { login?: string };
  html_url?: string;
}

interface PrDetails extends PrSummary {
  mergeable?: boolean | null;
  mergeable_state?: string;
  head?: { sha?: string };
}

interface StateEntry {
  reviewedAt?: string;
  approvedAt?: string;
  note?: string;
}

// ---------- Logging ----------

interface LogBuffer extends Array<string> {
  header?: string;
}
let logBuffer: LogBuffer | null = null;

const log = (...args: unknown[]): void => {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  if (logBuffer) logBuffer.push(line);
  else console.log(`[${new Date().toISOString()}] ${line}`);
};
const startGroup = (header: string): void => {
  const buf: LogBuffer = [];
  buf.header = header;
  logBuffer = buf;
};
const endGroup = (): void => {
  if (!logBuffer) return;
  const header = logBuffer.header ?? '';
  const lines = [...logBuffer];
  logBuffer = null;
  if (lines.length === 0) return;
  const ts = new Date().toISOString();
  const indented = lines.map((l) => `  ${l}`).join('\n');
  console.log(`[${ts}] ${header}\n${indented}`);
};

// ---------- State ----------

const activeRepos = new Set(REPOS);
let state: Record<string, StateEntry> = {};
let viewerLogin: string | null = null;

const loadState = async (): Promise<void> => {
  try {
    state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    state = {};
  }
};

const saveState = async (): Promise<void> => {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
};

// ---------- GitHub helpers ----------

interface GhResponse<T = any> {
  status: number;
  data: T;
}

const gh = async <T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<GhResponse<T>> => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
};

const getViewer = async (): Promise<string> => {
  const { status, data } = await gh<{ login: string }>('GET', '/user');
  if (status !== 200) {
    log('FATAL: GET /user failed', status, data);
    process.exit(1);
  }
  return data.login;
};

const listOpenPRs = async (repo: string): Promise<PrSummary[]> => {
  const { status, data } = await gh<PrSummary[] | { message?: string }>(
    'GET',
    `/repos/${OWNER}/${repo}/pulls?state=open&per_page=100`,
  );
  if (status === 404) {
    log(`repo ${repo} returned 404, dropping for this session`);
    activeRepos.delete(repo);
    return [];
  }
  if (status === 401 || status === 403) {
    log(`FATAL: ${status} listing ${repo}`, (data as any)?.message || data);
    process.exit(1);
  }
  if (status !== 200 || !Array.isArray(data)) {
    log(`error listing PRs for ${repo}: ${status}`, (data as any)?.message || data);
    return [];
  }
  return data;
};

const getMyReviewState = async (
  repo: string,
  prNumber: number,
): Promise<'APPROVED' | 'COMMENTED' | null> => {
  const { status, data } = await gh<any[]>(
    'GET',
    `/repos/${OWNER}/${repo}/pulls/${prNumber}/reviews`,
  );
  if (status !== 200 || !Array.isArray(data)) return null;
  const mine = data.filter((r) => r.user?.login === viewerLogin);
  if (mine.some((r) => r.state === 'APPROVED')) return 'APPROVED';
  if (mine.length > 0) return 'COMMENTED';
  return null;
};

const getPrDetails = async (
  repo: string,
  prNumber: number,
): Promise<PrDetails | null> => {
  const { status, data } = await gh<PrDetails>(
    'GET',
    `/repos/${OWNER}/${repo}/pulls/${prNumber}`,
  );
  return status === 200 ? data : null;
};

const getPrDiff = async (repo: string, prNumber: number): Promise<string> => {
  try {
    const res = await fetch(
      `${API}/repos/${OWNER}/${repo}/pulls/${prNumber}`,
      { headers: { ...headers, Accept: 'application/vnd.github.v3.diff' } },
    );
    if (!res.ok) return '';
    const text = await res.text();
    return text.length > 30_000
      ? text.slice(0, 30_000) + '\n...[truncated]'
      : text;
  } catch {
    return '';
  }
};

const hasFailingChecks = async (
  repo: string,
  sha: string,
): Promise<boolean> => {
  const { status, data } = await gh<{ check_runs?: any[] }>(
    'GET',
    `/repos/${OWNER}/${repo}/commits/${sha}/check-runs?per_page=100`,
  );
  if (status !== 200 || !Array.isArray(data?.check_runs)) return false;
  const bad = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);
  return data.check_runs.some(
    (c) => c.status === 'completed' && bad.has(c.conclusion),
  );
};

// ---------- GIF validation ----------

const validateGif = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'github-camo' },
    });
    if (!res.ok) {
      log(`gif HEAD ${res.status} for ${url}`);
      return false;
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const len = Number(res.headers.get('content-length') || '0');
    if (!ct.includes('image/gif')) {
      log(`gif rejected (content-type "${ct}") for ${url}`);
      return false;
    }
    if (len && len > MAX_GIF_BYTES) {
      log(`gif rejected (size ${len} > ${MAX_GIF_BYTES}) for ${url}`);
      return false;
    }
    return true;
  } catch (e) {
    log(`gif validation error for ${url}:`, (e as Error).message);
    return false;
  }
};

// ---------- Claude ----------

const extractJson = (text: string): any => {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
};

const ADVISORY =
  /\b(consider|could|might|maybe|perhaps|probably|would be better|nit\b|minor\b|nitpick|style\b|naming\b|cleaner|more readable|refactor|prefer|suggest(ion)?\b|optional\b|nice to have)\b/i;

const humanize = (s: string): string =>
  typeof s !== 'string'
    ? s
    : s
        .replace(/—/g, ', ')
        .replace(/–/g, '-')
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/…/g, '...')
        .replace(/ /g, ' ');

const askClaude = async (
  pr: PrDetails,
  diff: string,
  tried: string[],
  includeGif: boolean,
): Promise<ClaudeResult> => {
  const prompt = buildReviewPrompt({
    prTitle: pr.title || '',
    diff,
    triedGifUrls: tried,
    includeGif,
    gifTheme: GIF_THEME,
  });
  const { stdout } = await execFileAsync(CLAUDE_BIN, ['-p', prompt], {
    timeout: CLAUDE_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  const obj = extractJson(stdout || '');
  const summary = humanize(obj?.summary?.trim() || 'LGTM.');
  const issues: Issue[] = Array.isArray(obj?.issues)
    ? obj.issues
        .filter(
          (i: any) =>
            i &&
            typeof i.path === 'string' &&
            Number.isInteger(i.line) &&
            typeof i.body === 'string' &&
            i.body.trim().length > 0,
        )
        .map((i: any) => ({
          path: i.path,
          line: i.line,
          body: humanize(i.body),
          suggestion: humanize(i.suggestion || ''),
        }))
        .filter((i: Issue) => {
          if (ADVISORY.test(i.body)) {
            log(
              `dropping advisory-tone issue at ${i.path}:${i.line}: ${i.body.slice(0, 80)}`,
            );
            return false;
          }
          return true;
        })
    : [];
  const urls: string[] = Array.isArray(obj?.gifUrls)
    ? obj.gifUrls.filter(
        (u: unknown) =>
          typeof u === 'string' && /^https:\/\/\S+\.gif(\?\S*)?$/i.test(u),
      )
    : [];
  return { summary, issues, urls };
};

// ---------- Review building ----------

const FENCE = '```';

const buildInlineComments = (issues: Issue[]): InlineComment[] =>
  issues.map((i) => {
    const hasSuggestion =
      typeof i.suggestion === 'string' && i.suggestion.trim().length > 0;
    const suggestion = hasSuggestion
      ? '\n\n' + FENCE + 'suggestion\n' + i.suggestion + '\n' + FENCE
      : '';
    return {
      path: i.path,
      line: i.line,
      side: 'RIGHT',
      body: i.body.trim() + suggestion,
    };
  });

interface ReviewPayload {
  body: string;
  comments: InlineComment[];
}

const generateReview = async (
  pr: PrDetails,
  diff: string,
): Promise<ReviewPayload> => {
  const wantGif = Math.random() < GIF_PROBABILITY;
  const tried: string[] = [];
  let last: ClaudeResult = { summary: 'LGTM.', issues: [], urls: [] };
  let pickedGif: string | null = null;
  const rounds = wantGif ? MAX_GIF_ROUNDS : 1;
  for (let round = 1; round <= rounds; round++) {
    let result: ClaudeResult;
    try {
      result = await askClaude(pr, diff, tried, wantGif);
    } catch (err) {
      const e = err as ExecFileException & { stderr?: string };
      const reason = e.killed
        ? `timeout after ${CLAUDE_TIMEOUT_MS}ms`
        : e.code !== undefined
          ? `exit ${e.code}`
          : 'unknown error';
      const stderr = (e.stderr || '').toString().trim().slice(0, 200);
      log(
        `claude CLI failed on round ${round}: ${reason}${stderr ? ` | stderr: ${stderr}` : ''}`,
      );
      break;
    }
    last = result;
    if (!wantGif) break;
    for (const url of result.urls) {
      if (tried.includes(url)) continue;
      tried.push(url);
      if (await validateGif(url)) {
        pickedGif = url;
        break;
      }
    }
    if (pickedGif) break;
    log(
      `round ${round}: ${result.urls.length} GIF candidates rejected, retrying`,
    );
  }
  if (wantGif && !pickedGif)
    log(`no usable GIF after ${rounds} rounds, posting without one`);

  const bodyParts = [last.summary];
  if (pickedGif) bodyParts.push(`![lgtm](${pickedGif})`);
  return {
    body: bodyParts.join('\n\n'),
    comments: buildInlineComments(last.issues),
  };
};

// ---------- Submit review ----------

const postReview = (
  repo: string,
  prNumber: number,
  payload: Record<string, unknown>,
): Promise<GhResponse> =>
  gh('POST', `/repos/${OWNER}/${repo}/pulls/${prNumber}/reviews`, payload);

const submitReview = async (
  repo: string,
  pr: PrDetails,
  event: ReviewEvent,
  body: string | null,
  comments: InlineComment[] = [],
): Promise<boolean> => {
  const prNumber = pr.number;
  if (DRY) {
    log(
      `DRY_RUN: would ${event} ${pr.html_url}` +
        (body ? `\nbody:\n${body}` : '') +
        (comments.length
          ? `\ninline comments: ${JSON.stringify(comments, null, 2)}`
          : ''),
    );
    return true;
  }
  const payload: Record<string, unknown> = { event };
  if (body) payload.body = body;
  if (comments.length) payload.comments = comments;

  let { status, data } = await postReview(repo, prNumber, payload);

  if ((status === 422 || status === 400) && comments.length) {
    log(
      `inline comments rejected on ${OWNER}/${repo}#${prNumber}: ${data?.message || data}, retrying as body-only`,
    );
    const fallbackBody =
      (body || '') +
      '\n\n### Serious issues spotted\n\n' +
      comments
        .map((c) => `**${c.path}:${c.line}**\n${c.body}`)
        .join('\n\n');
    ({ status, data } = await postReview(repo, prNumber, {
      event,
      body: fallbackBody,
    }));
  }

  const verb =
    ({
      APPROVE: 'approved',
      COMMENT: 'commented on',
      REQUEST_CHANGES: 'requested changes on',
    } as const)[event] || event.toLowerCase();
  if (status === 200 || status === 201) {
    log(`${verb} ${pr.html_url}`);
    return true;
  }
  if (status === 422) {
    log(
      `422 on ${OWNER}/${repo}#${prNumber} (${event}), marking handled:`,
      data?.message || data,
    );
    return true;
  }
  log(
    `${event} failed ${OWNER}/${repo}#${prNumber}: ${status}`,
    data?.message || data,
  );
  return false;
};

// ---------- Main loop ----------

const inFlight = new Set<string>();
const lastWaitingState = new Map<string, string>();

const processPr = async (repo: string, prSummary: PrSummary): Promise<void> => {
  const prNumber = prSummary.number;
  const key = `${OWNER}/${repo}#${prNumber}`;
  if (state[key]?.approvedAt) return;
  if (prSummary.user?.login === viewerLogin) return;
  if (
    ALLOWED_AUTHORS.size > 0 &&
    !ALLOWED_AUTHORS.has(prSummary.user?.login || '')
  )
    return;

  const reviewState = await getMyReviewState(repo, prNumber);
  if (reviewState === 'APPROVED') {
    state[key] = {
      ...(state[key] || {}),
      approvedAt: new Date().toISOString(),
      note: 'pre-existing',
    };
    await saveState();
    return;
  }

  const pr = await getPrDetails(repo, prNumber);
  if (!pr) return;

  const conflict = pr.mergeable === false || pr.mergeable_state === 'dirty';
  const checksFailing = pr.head?.sha
    ? await hasFailingChecks(repo, pr.head.sha)
    : false;
  const ready = !conflict && !checksFailing;

  if (reviewState === 'COMMENTED' || state[key]?.reviewedAt) {
    if (!ready) {
      const stateStr = `conflict=${conflict} checksFailing=${checksFailing}`;
      if (lastWaitingState.get(key) !== stateStr) {
        log(`waiting on ${pr.html_url}: ${stateStr}`);
        lastWaitingState.set(key, stateStr);
      }
      return;
    }
    lastWaitingState.delete(key);
    const ok = await submitReview(repo, pr, 'APPROVE', null);
    if (ok) {
      state[key] = {
        ...(state[key] || {}),
        approvedAt: new Date().toISOString(),
      };
      await saveState();
    }
    return;
  }

  const diff = await getPrDiff(repo, prNumber);
  const { body, comments } = await generateReview(pr, diff);

  if (ready) {
    const ok = await submitReview(repo, pr, 'APPROVE', body, comments);
    if (ok) {
      state[key] = {
        reviewedAt: new Date().toISOString(),
        approvedAt: new Date().toISOString(),
      };
      await saveState();
    }
    return;
  }

  log(
    `commenting (not approving) ${pr.html_url}: conflict=${conflict} checksFailing=${checksFailing}`,
  );
  const ok = await submitReview(repo, pr, 'COMMENT', body, comments);
  if (ok) {
    state[key] = { reviewedAt: new Date().toISOString() };
    await saveState();
  }
};

const tick = async (): Promise<void> => {
  for (const repo of [...activeRepos]) {
    const prs = await listOpenPRs(repo);
    for (const pr of prs) {
      const key = `${OWNER}/${repo}#${pr.number}`;
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      startGroup(
        `${repo}#${pr.number} (${pr.user?.login || '?'}): ${pr.title || ''}`.slice(
          0,
          200,
        ),
      );
      try {
        await processPr(repo, pr);
      } catch (e) {
        log(`processPr error: ${(e as Error).message}`);
      } finally {
        endGroup();
        inFlight.delete(key);
      }
    }
  }
};

const main = async (): Promise<void> => {
  await loadState();
  viewerLogin = await getViewer();
  log(
    `viewer: ${viewerLogin}, owner: ${OWNER}, repos: ${REPOS.length}, interval: ${INTERVAL}ms, dry: ${DRY}`,
  );
  let running = false;
  const runTick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (e) {
      log('tick error:', e);
    } finally {
      running = false;
    }
  };
  await runTick();
  setInterval(runTick, INTERVAL);
};

const shutdown = async (sig: string): Promise<void> => {
  log(`received ${sig}, flushing state`);
  try {
    await saveState();
  } catch (e) {
    log('saveState error on shutdown:', e);
  }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  log('fatal:', e);
  process.exit(1);
});
