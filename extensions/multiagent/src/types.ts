/** Shared contracts for the detached-only Pi multiagent package. */

export type AgentTeamAction = "catalog" | "start" | "run_status" | "step_result" | "message" | "cancel" | "cleanup" | "list" | "reattach" | "missing/invalid";
export type ExecutionAction = Exclude<AgentTeamAction, "missing/invalid">;
export type AgentSource = "package" | "user" | "project" | "inline";
export type LibrarySource = "package" | "user" | "project";
export type ProjectAgentsPolicy = "deny" | "confirm" | "allow";
export type InvocationAgentKind = "inline" | "library";
export type ThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type RunStatus = "running" | "succeeded" | "mixed" | "failed" | "canceling" | "canceled" | "expired";
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "blocked" | "timed_out" | "canceled";
export type MessageChannel = "steer" | "follow_up";
export type NotifyMode = "none" | "final" | "milestones";
export type SubagentSkillMode = "enabled" | "disabled" | "auto";
export type WorktreeIsolationMode = "worktree";
export type EventType = "run" | "step" | "assistant_delta" | "assistant_final" | "tool" | "diagnostic" | "parent_message" | "rpc" | "ui";

export const DEFAULT_LIBRARY_SOURCES: LibrarySource[] = ["package"];
export const DEFAULT_GRAPH_LIBRARY_SOURCES: LibrarySource[] = ["package"];
export const DEFAULT_PROJECT_AGENTS_POLICY: ProjectAgentsPolicy = "deny";
export const LIBRARY_SOURCE_VALUES = ["package", "user", "project"] as const;
export const PROJECT_AGENTS_POLICY_VALUES = ["deny", "confirm", "allow"] as const;
export const AGENT_TEAM_ACTION_VALUES = ["catalog", "start", "run_status", "step_result", "message", "cancel", "cleanup", "list", "reattach"] as const;
export const INVOCATION_AGENT_KIND_VALUES = ["inline", "library"] as const;
export const THINKING_LEVEL_VALUES = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const RUN_STATUS_VALUES = ["running", "succeeded", "mixed", "failed", "canceling", "canceled", "expired"] as const;
export const STEP_STATUS_VALUES = ["pending", "running", "succeeded", "failed", "blocked", "timed_out", "canceled"] as const;
export const MESSAGE_CHANNEL_VALUES = ["steer", "follow_up"] as const;
export const NOTIFY_MODE_VALUES = ["none", "final", "milestones"] as const;
export const SUBAGENT_SKILL_MODE_VALUES = ["enabled", "disabled", "auto"] as const;
export const WORKTREE_ISOLATION_VALUES = ["worktree"] as const;
export const PUBLIC_ID_PATTERN = "^[a-z][a-z0-9-]{0,62}$";
export const RUN_ID_PATTERN = "^r[1-9][0-9]{0,6}$";
export const SCHEDULE_ID_PATTERN = "^s[1-9][0-9]{0,6}$";
export const SOURCE_QUALIFIED_LIBRARY_REF_PATTERN = "^(package|user|project):[a-z][a-z0-9-]{0,62}$";
export const TOOL_NAME_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,63}$";
export const BUILTIN_CHILD_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export const READONLY_CHILD_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
export const SHELL_CHILD_TOOL_NAMES = ["bash"] as const;
export const MUTATION_CHILD_TOOL_NAMES = ["edit", "write"] as const;
export const EXTENSION_SOURCE_SCOPE_VALUES = ["user", "project", "temporary"] as const;
export const EXTENSION_SOURCE_ORIGIN_VALUES = ["package", "top-level"] as const;
export const SKILL_NAME_PATTERN = "^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";

export type BuiltinChildToolName = (typeof BUILTIN_CHILD_TOOL_NAMES)[number];
export type ExtensionSourceScope = (typeof EXTENSION_SOURCE_SCOPE_VALUES)[number];
export type ExtensionSourceOrigin = (typeof EXTENSION_SOURCE_ORIGIN_VALUES)[number];
export type ExtensionToolTrustPolicy = "deny" | "allow";

export const MAX_STEPS = 16;
export const MAX_DEPENDENCIES_PER_STEP = 12;
export const MAX_CONCURRENCY = 6;
export const DEFAULT_TIMEOUT_SECONDS_PER_STEP = 7200;
export const MAX_TIMEOUT_SECONDS_PER_STEP = 36000;
export const INLINE_HANDOFF_CHARS = 12000;
export const INLINE_HANDOFF_PREVIEW_CHARS = 2000;
export const MAX_TEXT_FIELD_CHARS = 50000;
export const MAX_SHORT_TEXT_FIELD_CHARS = 1000;
export const MAX_PATH_FIELD_CHARS = 4096;
export const MAX_CALLER_SKILLS = 128;
export const MAX_GRAPH_FILE_BYTES = 256 * 1024;
export const MAX_AGENT_FILE_BYTES = 128 * 1024;
export const DEFAULT_MAX_RUN_SECONDS = 86400;
export const MAX_MAX_RUN_SECONDS = 86400;
export const DEFAULT_TERMINAL_RETENTION_SECONDS = 86400;
export const MAX_TERMINAL_RETENTION_SECONDS = 604800;
export const DEFAULT_RESULT_PREVIEW_MAX_BYTES = 50 * 1024;
export const MAX_RESULT_PREVIEW_BYTES = 200000;
export const MAX_RUN_STATUS_WAIT_SECONDS = 60;
export const DEFAULT_NOTIFY_MODE: NotifyMode = "milestones";
export const DEFAULT_NOTIFY_MAX_NOTICES = 12;
export const MAX_NOTIFY_MAX_NOTICES = 100;
export const DEFAULT_NOTIFY_MIN_INTERVAL_SECONDS = 10;
export const MAX_NOTIFY_MIN_INTERVAL_SECONDS = 3600;
export const MAX_PARENT_MESSAGE_CHARS = 50000;
export const MAX_CLIENT_MESSAGE_ID_CHARS = 128;
export const MAX_EVENTS_PER_RUN = 2000;
export const MAX_LIVE_DETACHED_RUNS = 16;
export const MAX_RETAINED_DETACHED_RUNS = 64;
export const MAX_PARENT_MESSAGES_PER_STEP = 16;
export const MAX_PARENT_MESSAGE_CHARS_PER_STEP = 65536;
export const MAX_STEP_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP = 64;
export const RPC_RECORD_MAX_CHARS = 8 * 1024 * 1024;
export const STDERR_PREVIEW_CHARS = 6000;
export const EVENT_PREVIEW_CHARS = 2000;

export interface AgentDiagnostic {
	code: string;
	message: string;
	path: string | undefined;
	severity: "info" | "warning" | "error";
	action?: AgentTeamAction;
	fields?: string[];
	repair?: string;
}

export interface LibraryOptions {
	sources: LibrarySource[];
	query: string | undefined;
	projectAgents: ProjectAgentsPolicy;
}

export interface GraphLibraryOptions {
	sources: LibrarySource[];
}

export interface GraphAuthority {
	allowFilesystemRead: boolean;
	allowShellTools: boolean;
	allowMutationTools: boolean;
	allowExtensionCode: boolean;
	allowProjectCode: boolean;
	allowMutationWorktree: boolean;
}

export interface TeamLimits {
	concurrency: number;
	timeoutSecondsPerStep: number;
}

export interface NotifyOptions {
	mode: NotifyMode;
	maxNotices: number;
	minIntervalSeconds: number;
}

export interface ScheduleSpec {
	/** Interval format: "30s", "5m", "1h", "2d". Range 1s–30d. Fires repeatedly. */
	interval?: string;
	/** One-shot: ISO timestamp ("2026-12-25T09:00:00Z") OR relative "+10m". Range +0…+30d. */
	oneShot?: string;
}

export interface ScheduledRunSummary {
	scheduleId: string;
	kind: "interval" | "oneShot";
	intervalMs: number | undefined;
	nextFireAt: string | undefined;
	createdAt: string;
	fireCount: number;
	lastFireAt: string | undefined;
	lastFireError: string | undefined;
	ownerSessionId: string | undefined;
	objective: string;
	stepCount: number;
}

export interface ScheduleRegistrationReceipt {
	scheduleId: string;
	kind: "interval" | "oneShot";
	nextFireAt: string | undefined;
}

export interface ScheduleCancelReceipt {
	scheduleId: string;
	canceled: boolean;
	reason: string | undefined;
}

export interface StartOptions {
	maxRunSeconds: number;
	terminalRetentionSeconds: number;
	notify: NotifyOptions;
	schedule: ScheduleSpec | undefined;
}

export interface AgentConfig {
	name: string;
	ref: string;
	description: string;
	tags: string[];
	tools: string[] | undefined;
	model: string | undefined;
	fallbackModels?: string[];
	thinking: Exclude<ThinkingLevel, "inherit"> | undefined;
	systemPrompt: string;
	source: Exclude<AgentSource, "inline">;
	filePath: string;
	sha256: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	diagnostics: AgentDiagnostic[];
	packageAgentsDir: string;
	userAgentsDir: string;
	projectAgentsDir: string | undefined;
	sources: LibrarySource[];
	projectAgents: ProjectAgentsPolicy;
}

export interface ExtensionToolProvenanceSpec {
	source: string;
	scope?: ExtensionSourceScope;
	origin?: ExtensionSourceOrigin;
}

export interface ExtensionToolGrantSpec {
	name: string;
	from: ExtensionToolProvenanceSpec;
}

export interface ExtensionToolPolicy {
	projectExtensions: ExtensionToolTrustPolicy;
	localExtensions: ExtensionToolTrustPolicy;
}

export interface ParentSkillSourceInfo {
	path: string;
	source: string;
	scope: ExtensionSourceScope;
	origin: ExtensionSourceOrigin;
	baseDir: string | undefined;
}

export interface ParentSkillInfo {
	name: string;
	description: string | undefined;
	sourceInfo: ParentSkillSourceInfo;
}

export interface ParentSkillInventory {
	apiAvailable: boolean;
	readActive: boolean;
	errorMessage: string | undefined;
	skills: ParentSkillInfo[];
}

export interface ResolvedCallerSkillSource extends ParentSkillSourceInfo {
	realpath: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	sha256: string;
}

export interface ResolvedCallerSkill {
	name: string;
	description: string | undefined;
	source: ResolvedCallerSkillSource;
}

export interface ParentToolSourceInfo {
	path: string;
	source: string;
	scope: ExtensionSourceScope;
	origin: ExtensionSourceOrigin;
	baseDir: string | undefined;
}

export interface ParentToolInfo {
	name: string;
	description: string | undefined;
	sourceInfo: ParentToolSourceInfo;
	active: boolean;
}

export interface ParentToolInventory {
	apiAvailable: boolean;
	errorMessage: string | undefined;
	tools: ParentToolInfo[];
}

export interface ResolvedExtensionSource {
	path: string;
	realpath: string;
	source: string;
	scope: ExtensionSourceScope;
	origin: ExtensionSourceOrigin;
	baseDir: string | undefined;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	sha256: string | undefined;
}

export interface ResolvedExtensionToolGrant {
	name: string;
	description: string | undefined;
	source: ResolvedExtensionSource;
}

interface GraphStepAgentSharedInput {
	tools?: string[];
	extensionTools?: ExtensionToolGrantSpec[];
	/** Optional child model lane override. For inline agents, this is the only source of child model metadata. */
	model?: string;
	/** Optional ordered fallback child model lanes, tried in order if the primary model fails with a retryable model/provider error. */
	fallbackModels?: string[];
	/** Optional child thinking lane override. `inherit` means use parent defaults. */
	thinking?: ThinkingLevel;
}

export interface GraphStepAgentInput extends GraphStepAgentSharedInput {
	system?: string;
	ref?: string;
}

export interface StepOutputLimitSpec {
	/** Per-step soft cap on retained assistant output bytes. Must be a positive integer <= MAX_STEP_OUTPUT_BYTES. Clamps the global per-step cap downward. Useful for keeping low-output steps tightly bounded; raising above the global cap is denied at planning time. */
	maxBytes?: number;
	/** Per-step soft cap on number of non-empty assistant final messages. Must be a positive integer <= MAX_ASSISTANT_FINAL_MESSAGES_PER_STEP. */
	maxAssistantFinals?: number;
}

export interface WorktreeSetupSpec {
	/** When true, symlink `node_modules/` from the invocation cwd into the worktree root if present. */
	propagateNodeModules?: boolean;
	/** Additional relative paths to symlink from invocation cwd into the worktree. Must not escape; must exist as a file or directory in the source. */
	symlinkPaths?: string[];
}

export interface GraphStepInput {
	id: string;
	agent: GraphStepAgentInput;
	task: string;
	mutationScope?: string;
	needs?: string[];
	after?: string[];
	cwd?: string;
	isolation?: WorktreeIsolationMode;
	worktreeSetup?: WorktreeSetupSpec;
	outputLimit?: StepOutputLimitSpec;
}

export interface GraphSpecInput {
	objective: string;
	library?: { sources?: LibrarySource[] };
	authority?: Partial<GraphAuthority>;
	steps: GraphStepInput[];
	limits?: Partial<TeamLimits>;
}

export interface ResolvedAgent {
	id: string;
	ref: string;
	name: string;
	kind: InvocationAgentKind;
	description: string;
	tools: string[];
	extensionTools: ResolvedExtensionToolGrant[];
	callerSkills: ResolvedCallerSkill[];
	systemPrompt: string;
	model: string | undefined;
	fallbackModels?: string[];
	thinking: Exclude<ThinkingLevel, "inherit"> | undefined;
	source: AgentSource;
	filePath: string | undefined;
	sha256: string | undefined;
}

export interface CwdIdentity {
	realpath: string;
	dev: number;
	ino: number;
}

export interface TeamStepSpec {
	id: string;
	agent: ResolvedAgent;
	task: string;
	mutationScope: string | undefined;
	needs: string[];
	after: string[];
	cwd: string;
	cwdIdentity: CwdIdentity;
	isolation: WorktreeIsolationMode | undefined;
	worktreeSetup: WorktreeSetupSpec | undefined;
	outputLimit: StepOutputLimitSpec | undefined;
}

export interface MutationWorktreeState {
	stepId: string;
	worktreePath: string;
	branchName: string;
	baseCommit: string;
	repoRoot: string;
}

export interface WorktreeTeardownEvidence {
	diffStat: string | undefined;
	patchPath: string | undefined;
	branchName: string;
	baseCommit: string;
	cleanupWarnings: string[];
}

export interface ResolvedGraph {
	objective: string;
	library: GraphLibraryOptions;
	authority: GraphAuthority;
	steps: TeamStepSpec[];
	limits: TeamLimits;
	options: StartOptions;
	graphHash: string;
	diagnostics: AgentDiagnostic[];
}

export interface BackgroundEvent {
	seq: number;
	time: string;
	stepId: string | undefined;
	type: EventType;
	label: string | undefined;
	preview: string | undefined;
	status: string | undefined;
}

export interface RunSnapshot {
	runId: string;
	objective: string;
	status: RunStatus;
	terminal: boolean;
	createdAt: string;
	updatedAt: string;
	expiresAt: string | undefined;
	liveStepIds: string[];
	sinkStepIds: string[];
	lastEvent: string | undefined;
	canMessage: boolean;
	canCancel: boolean;
	canCleanup: boolean;
	counts: Record<StepStatus, number>;
}

export interface StepArtifactReference {
	stepId: string;
	status: StepStatus | "missing";
	filePath: string | undefined;
	chars: number | undefined;
}

export interface StepSnapshot {
	id: string;
	status: StepStatus;
	agentRef: string;
	model: string | undefined;
	thinking: string | undefined;
	effectiveTools: string[];
	extensionTools: string[];
	callerSkills: string[];
	needs: string[];
	after: string[];
	startedAt: string | undefined;
	endedAt: string | undefined;
	lastActivity: string | undefined;
	errorMessage: string | undefined;
	outputFilePath?: string;
	outputChars?: number;
	taskPreview?: string;
	cwd?: string;
	stopReason?: string;
	upstreamArtifacts?: StepArtifactReference[];
	isolation?: WorktreeIsolationMode;
	worktreeDiffStat?: string;
	worktreePatchPath?: string;
	worktreeBranch?: string;
}

export interface StepOutput {
	stepId: string;
	status: StepStatus;
	text: string | undefined;
	filePath: string | undefined;
	chars: number;
}

export type RunStatusWaitOutcome = "material" | "timeout" | "already-material" | "terminal";

export interface RunStatusWaitReceipt {
	requestedSeconds: number;
	outcome: RunStatusWaitOutcome;
	stepId: string | undefined;
	cursorBefore: string;
	cursorAfter: string;
}

export interface MessageReceipt {
	runId: string;
	stepId: string;
	channel: MessageChannel;
	clientMessageId: string | undefined;
	accepted: boolean;
	undeliveredReason: string | undefined;
	reused?: boolean;
}

export interface AgentTeamNotice {
	runId: string;
	mode: NotifyMode;
	terminal: boolean;
	reasons: string[];
	noticeCount: number;
	noticeLimitReached: boolean;
}

export interface CleanupReceipt {
	runId: string;
	deletedPaths: string[];
}

export interface AgentTeamError {
	code: string;
	message: string;
}

export interface CatalogAgentSummary {
	name: string;
	ref: string;
	source: Exclude<AgentSource, "inline">;
	description: string;
	tags: string[];
	tools: string[] | undefined;
	model: string | undefined;
	thinking: string | undefined;
	filePath: string;
	sha256: string;
}

export interface CatalogExtensionToolSummary {
	name: string;
	description: string | undefined;
	from: ExtensionToolProvenanceSpec;
	active: boolean;
	requiresProjectCode?: boolean;
}

export interface ListedRunSummary {
	runId: string;
	status: string;
	terminal: boolean;
	owned: boolean;
	owner: "this-session" | "foreign-session" | "orphan" | "unknown";
	ownerPid: number | undefined;
	ownerPidAlive: boolean | undefined;
	ownerSessionId: string | undefined;
	createdAt: string;
	updatedAt: string | undefined;
	terminalAt: string | undefined;
	invocationCwd: string | undefined;
	objective: string | undefined;
	runDir: string;
	worktreeCount: number;
	worktreesPendingCleanup: number;
}

export interface ReattachSnapshot {
	runId: string;
	runDir: string;
	owned: boolean;
	owner: "this-session" | "foreign-session" | "orphan" | "unknown";
	manifest: {
		runId: string;
		createdAt: string;
		invocationCwd: string;
		objective: string;
		ownerPid: number;
		ownerSessionId: string | undefined;
		piVersion: string | undefined;
		terminalRetentionSeconds: number;
	};
	status: {
		status: string;
		updatedAt: string;
		terminal: boolean;
		terminalAt: string | undefined;
	} | undefined;
	worktrees: { stepId: string; worktreePath: string; branchName: string; baseCommit: string; repoRoot: string; cleanedUp: boolean }[];
	artifactPaths: { name: string; path: string; size: number }[];
	readOnly: true;
	controlDenied: boolean;
	controlDeniedReason: string | undefined;
}

export interface AgentTeamDetails {
	kind: "agent_team";
	action: AgentTeamAction;
	ok: boolean;
	diagnostics: AgentDiagnostic[];
	error: AgentTeamError | undefined;
	library: LibraryOptions | undefined;
	catalog: CatalogAgentSummary[];
	extensionTools: CatalogExtensionToolSummary[];
	run: RunSnapshot | undefined;
	cursor: string | undefined;
	events: BackgroundEvent[];
	steps: StepSnapshot[];
	outputs: StepOutput[];
	wait: RunStatusWaitReceipt | undefined;
	message: MessageReceipt | undefined;
	cleanup: CleanupReceipt | undefined;
	notice: AgentTeamNotice | undefined;
	listedRuns: ListedRunSummary[] | undefined;
	reattach: ReattachSnapshot | undefined;
	scheduledRuns: ScheduledRunSummary[] | undefined;
	scheduleRegistration: ScheduleRegistrationReceipt | undefined;
	scheduleCancel: ScheduleCancelReceipt | undefined;
}

export interface AgentInvocationDefaults {
	model: string | undefined;
	thinking: string | undefined;
}
