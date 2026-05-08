// Copy this file to `src/repos.ts` and edit with the real repos you want
// polled. `src/repos.ts` is gitignored so your service names stay out of
// source control.
//
// Alternative: leave src/repos.ts using these placeholders and override at
// runtime with GITHUB_REPOS=repo1,repo2,repo3 in your .env file.
export const DEFAULT_REPOS: string[] = [
  'example-frontend',
  'example-backend',
];
