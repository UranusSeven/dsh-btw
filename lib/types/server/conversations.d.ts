import type { SideResult } from '../shared';
import { type BtwLocale } from '../locales';
/**
 * 一轮旁问的生命周期结果。
 *
 * 宿主 0.2.1 的 continuable 子代理在「一轮答完且没有排队输入」后会自然结算并
 * 释放激活名额；因此本注册表不假设轮次结束后仍有驻留 Agent。追问统一走
 * `subagents.prompt` / 内部 `deliverSubagentPrompt` 的冷恢复路径，childId 是
 * 唯一需要跨轮保留的宿主句柄。
 */
export interface ConversationHandle {
    /** 中断并释放整条会话，同时释放插件侧的 guard/label 资源。 */
    dispose(): Promise<void>;
    /** 只释放宿主激活名额（保留 childId 供冷恢复），不动插件侧 guard/label。 */
    release?(): Promise<void>;
}
export interface ConversationStartInput {
    parent: unknown;
    parentSessionId: string;
    childId: string;
    prompt: string;
    signal: AbortSignal;
    locale: BtwLocale;
}
export interface ConversationDeliverInput {
    parent: unknown;
    parentSessionId: string;
    childId: string;
    text: string;
    signal: AbortSignal;
}
export interface ConversationHost {
    /** 订阅宿主的 session/event；回调必须同步、不能抛错。 */
    watch(listener: (session: SessionLike, event: SessionEventLike) => void): () => void;
    start(input: ConversationStartInput): Promise<ConversationHandle>;
    deliver(input: ConversationDeliverInput): Promise<void>;
    interrupt(parentSessionId: string, childId: string): void;
    /** 可选：释放冷恢复后的驻留激活（宿主 drainChildren）。 */
    drain?(parent: unknown, childId: string): Promise<void>;
    newChildId(): string;
}
export interface SessionEventLike {
    readonly type: string;
    readonly data?: unknown;
}
export interface SessionLike {
    readonly id?: string;
    readonly header?: {
        readonly id?: string;
    };
}
export interface ConversationOptions {
    maxActive?: number;
    maxTurns?: number;
    maxPerParent?: number;
    timeoutMs?: number;
    cleanupTimeoutMs?: number;
    /** 一轮结束后保留宿主激活的时长；0 表示依赖宿主自然结算。 */
    idleTtlMs?: number;
    onError?: (error: Error) => void;
    /** 卸载后所有迟到的启动也释放完毕时调用；用于注销根 guard。 */
    onIdle?: () => void | Promise<void>;
}
export declare const DEFAULT_TURN_TIMEOUT_MS = 1800000;
/**
 * 多轮旁问注册表：一个气泡对应一个 continuable 子会话。
 *
 * - 轮次输出通过 `session/event` 收敛，不依赖 `activation.result`（后者只在
 *   激活释放后才结算，无法支撑轮次间等待）。
 * - `turn` 由客户端递增，成功的轮次结果按 turn 缓存，网络重试直接回放。
 * - 正在进行的同一 turn 被重复提交时返回同一个 Promise，不重复投递。
 */
export declare class ConversationRegistry {
    private readonly host;
    private readonly options;
    private readonly entries;
    private readonly byChild;
    private readonly waiters;
    private readonly retired;
    /** 关闭后的 childId 仍保留一小段时间，用于过滤宿主迟到的 subagent-settled 通知。 */
    private readonly retiredChildren;
    private readonly stopWatch;
    private readonly starting;
    private active;
    private disposed;
    constructor(host: ConversationHost, options?: ConversationOptions);
    /** 条目 + 仍在启动中的轮次；卸载时用来等迟到句柄。 */
    get size(): number;
    get activeSize(): number;
    /** 该 childId 是否属于本插件；用于识别并丢弃宿主发给主会话的结算通知。 */
    parentOfChild(childId: string): string | undefined;
    start(parentSessionId: string, bubbleId: string, prompt: string, signal: AbortSignal, parent: unknown, locale?: BtwLocale): Promise<SideResult>;
    reply(parentSessionId: string, bubbleId: string, turn: number, text: string, signal: AbortSignal, parent: unknown, locale?: BtwLocale): Promise<SideResult>;
    /** 只中断当前轮；条目与已完成轮次保留，客户端可以立即重试。 */
    stop(parentSessionId: string, bubbleId: string): SideResult;
    /** 关闭是终态：中断、释放激活、删除条目，并留下 5 分钟墓碑挡住迟到投递。 */
    close(parentSessionId: string, bubbleId: string, parent?: unknown): Promise<SideResult>;
    dispose(): Promise<void>;
    private runTurn;
    private executeTurn;
    private openWaiter;
    private finishWaiter;
    private closeWaiter;
    private observe;
    /** 立即结算当前等待者；不依赖模型在中断后补发 turn/end。 */
    private cancelWaiter;
    private interrupt;
    private failureFor;
    private remove;
    /** 一轮结束后释放宿主激活名额，但保留 childId 与插件 guard，追问走冷恢复。 */
    private scheduleIdle;
    private clearIdle;
    private retire;
    private prune;
    private bounded;
    private report;
}
