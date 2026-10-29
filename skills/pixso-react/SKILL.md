---
name: pixso-react
description: Transfer a Pixso design or selected screen/microfrontend to React and TypeScript with the local Node MCP runtime, project components and mock data, versioned complete artifacts, parallel GigaCode workers, ordinary CSS and independent visual verification. Use for Pixso design implementation and updates.
---

# Pixso → React

Use the installed local `pixso-react` MCP runtime as the coordinator. Discover its tools before invoking them; use its CLI when MCP is unavailable. The package's Node process performs capture, versioning, chunking, task scheduling and checks. This skill provides the workflow, not an alternative runtime.

The runtime exposes `pixso_status`, `pixso_inspect`, `pixso_start_job`, `pixso_job_status`, `pixso_import`, `pixso_scope`, `pixso_snapshot`, `pixso_plan`, `pixso_baseline`, `pixso_apply`, `pixso_accept`, `pixso_diff` and `pixso_read_artifact`. Start with `pixso_status` and `pixso_inspect`. Use `pixso_start_job` for capture/run/transfer/verify, persist its job ID, and poll `pixso_job_status` for completion. Prefer action `transfer` for automatic generation, apply, acceptance and bounded repair; use `run` for staging-only work and `pixso_accept` for the aggregate gate after manual apply. For long files use `pixso_read_artifact` repeatedly until `nextOffset` is null. Read current tool schemas rather than guessing argument names.

## Establish project context

Read `pixso-react.config.json`, existing project instructions, package metadata, representative component files and ordinary CSS files. Reuse the real project's class naming, spacing conventions, components and dependencies. Propose `<project>/.pixso-artifacts` when no artifact path is supplied; honor an explicitly configured directory. Never mix captures from different design revisions.

Inspect project mocks, fixtures, factories, handlers, Storybook and data hooks through `project-profile.data`. Respect `generation.data.mockFiles` and `instructions`; `generation.data.setupFile` is inventoried existing mock bootstrap, not an automatically executed preview entry. The browser harness exclusively uses `validation.setupFile`, exporting async `preparePixsoPreview({screenId})` and returning `{props?, Provider?}`. Connect existing project mechanisms and providers; never invent a new data library or move mock setup into production views.

Read the runtime's current CLI help/MCP tool schemas. Do not invent Pixso tool names, GigaCode flags, component APIs or registry credentials. GigaCode CLI is the GitVerse corporate product, not an unrelated package with the same name. Configure the actual executable. Empty `gigacode.args` asks the runtime to inspect its `--help`; explicit argument arrays need `{promptFile}` or `{prompt}`.

## Obtain complete design evidence

Capture through the configured developer Pixso MCP or import a full local export produced by the supplied Pixso exporter. Persist raw responses and assets before showing summaries to the model. A truncated tree, omitted text, missing child IDs, missing images or unknown completeness must never be labelled complete.

Read the version manifest, node index and relevant screen/widget indexes first. Resolve every indexed property chunk in order to recover the exact original node JSON. Preserve all fields, text runs, layout constraints, component instances, variables, asset references and screenshot evidence. Split screens into large widgets only when needed to stay within context limits; retain parent layout and node ownership.

Stop claims of completeness if the available source cannot prove complete capture. Explain the missing source capability and retain a diagnostic report; a renderer cannot reconstruct data the upstream service never supplied.

For a partial screen or microfrontend, pass explicit node IDs to capture (`--nodes "12:34,56:78"` / MCP `nodeIds`) or use `pixso_scope` on an existing immutable snapshot. Implement only those roots and descendants. Read `capture.scope.ancestors` as host context, never add those ancestors or siblings to implementation coverage. Each selected root requires its own independent Pixso PNG at scale=1. If an existing snapshot lacks it, recapture the selected nodes or import an exact selected-node export; never crop the host screenshot and call it independent evidence. State the selected scope in the final result.

Screen changelogs are optional and off by default (`versioning.screenChangelog:false`). When enabled, or an explicit `changeNote` is supplied, the runtime writes one short dated `CHANGELOG.md` per screen into the new version. `previousSnapshot` can select the baseline. Compare only the same file, root selection and screen ID. Do not append to older versions, repeat full node trees in logs, or use a human summary as acceptance evidence.

## Run the parallel implementation

Let the runtime plan analysis tasks by screens/widgets and dispatch the bounded GigaCode swarm. Keep all input artifacts immutable. Each worker has its own attempt cwd and output directory. Never have two workers write shared CSS, routing, package files or project configuration.

Read all analysis outputs, validate reviewed node IDs against the exact assigned inventory and carry unresolved findings into implementation. Implement full screens with React, TypeScript, semantic accessible markup, real controls and ordinary external CSS classes. Map to existing components only after reading their actual APIs and styles. Do not use a full-screen screenshot as implementation.

Component compatibility is a mandatory gate before implementation. Read `component-plan.json` and `component-gaps.md`. Every assigned node needs an explicit native/reuse/adapt/create/unknown decision. Reuse must cite actual source hashes, exports and relevant API/CSS evidence. Never substitute a nearest-looking library component or describe an incompatible variant as compatible. Missing, adaptation-required, unknown or unresolved decisions block transfer before apply. Do not overwrite these findings with an empty implementation unsupported list.

When status is `blocked-design-system`, tell the user which components are missing, which need adaptation, the affected screen/node IDs, exact required changes, and the gap report path. Include the report's concrete AI task so the user can add/adapt the design-system components with AI and rerun. Do not merely say that generation failed. Do not automatically alter shared library APIs or replace the chosen design system to get a passing result.

Project-data compatibility is also mandatory. Every assigned node needs `dataBindings` with a justified none/static/dynamic/unknown classification. Business/example values such as customers, amounts, dates, counts and repeated records must use actual props/hooks/context backed by inventoried project scenarios; ordinary UI labels may remain static. Read `data-plan.json` and `data-gaps.md`. Missing scenarios, API adapters, preview setup, incomplete inventory and unknown decisions produce `blocked-project-data` before generation/apply. Explain affected IDs, concrete project-native changes and the report's AI task. Never relabel business values as static to clear a blocker, hardcode them in JSX or import fixtures into production components. After fixing the scenario, repeat analysis and transfer. Semantic classification remains model judgment; AST checks and source hashes only verify the declared evidence.

Require exact expected filenames and structured coverage reports from each worker. Preserve `data-pixso-id` on rendered design elements so geometry and coverage can be checked. Save all attempts and logs. Use resume for an interrupted run; use a new design version when the source changes.

## Integrate and verify

Use the coordinator's validated apply operation for the generated files. Preserve subsequent user edits through the ownership ledger. Integrate screens with the existing project routes and compile using its configured commands. Do not say that producing staging files completes the transfer.

Render the local implementation with Playwright at the design viewport. Compare exported Pixso reference images, DOM geometry, visibility, text and node coverage; store screenshots, differences and reports with the run. Corporate Pixso browser access is unnecessary for this path. Fonts and image assets must be loaded before capturing.

Pixel-perfect means `pixelPerfect:true` from aggregate acceptance of every captured screen: zero differing decoded RGBA pixels, no antialias masking, exact dimensions, stable rendering, verified component/data plans, and successful installed-code checks. Configured project URLs are additional integration checks and never replace the mandatory harness of installed files or its data setup. Tolerant results are diagnostic, always incomplete, and must never be called pixel-perfect. Never lower thresholds, resize/mutate references, hide differences, or place a reference PNG over UI to pass. If font rendering differs between Pixso and the local browser, report the mismatch instead of promising equality. A verified snapshot does not prove uncaptured states, other breakpoints or other browsers.

Repair discrepancies using the reports and rerun checks until the acceptance criteria pass or a concrete external blocker remains. A bounded failed retry is a failure, not acceptance. Report unsupported source features and unavailable checks precisely. Never fabricate pixel accuracy, complete node coverage, a passing build or a successful GigaCode run.

See [GigaCode integration](../../docs/gigacode.md) in the distribution for argument placeholders, process journals, restart behavior and verified vendor documentation.
