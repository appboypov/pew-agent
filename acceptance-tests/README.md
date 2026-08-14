# Prime Agent acceptance tests

This independent Cucumber project executes the effective Pew OpenSpec requirements from `/Users/codaveto/Workspace/openspec/pew`. Archived changes are excluded by the canonical effective-spec composer.

## Run

```sh
cd acceptance-tests
npm install
npm test
npm run lint:specs
```

`npm test` extracts the active requirements, runs the focused daemon/custom-UI probes against the repository's Prime Agent implementation, and writes `reports/cucumber-report.html`. The probe page object starts Vitest as a controlled child process and waits for it to stop; no daemon or test process is left running.

Generated `.extracted/` specs and `reports/` are gitignored and rebuilt for each run.
