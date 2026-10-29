import { type SideResult } from '../shared';
import { type BtwTranslate } from '../locales';
export type TurnPhase = 'answering' | 'done' | 'error';
/** 气泡内的一轮问答；追问复用同一子会话，历史按轮次累积。 */
export interface Turn {
    question: string;
    reference?: string;
    answer: string;
    phase: TurnPhase;
    error?: string;
    cancelled?: boolean;
}
export interface Bubble {
    id: string;
    sessionId: string;
    question: string;
    reference?: string;
    answer: string;
    phase: 'answering' | 'done' | 'error' | 'partial' | 'closing';
    error?: string;
    closeFailed?: boolean;
    turns?: Turn[];
    /** 从 localStorage 恢复的历史气泡；可在服务端会话仍有效时继续追问。 */
    restored?: boolean;
}
export interface SideTransport {
    run(session: string, id: string, question: string, signal: AbortSignal, reference?: string): Promise<SideResult>;
    reply?(session: string, id: string, turn: number, text: string, signal: AbortSignal, reference?: string): Promise<SideResult>;
    stop?(session: string, id: string): Promise<SideResult>;
    /** 显式能力探测；旧服务端没有该命令时返回 false，追问框自动隐藏。 */
    probe?(session: string): Promise<boolean>;
    close(session: string, id: string): Promise<SideResult>;
}
/** 宿主在进入 handler 前明确拒绝启动；没有后台任务需要清理。 */
export declare class SideRequestNotStartedError extends Error {
}
/** 仅内存 UI 状态；关闭请求与答案返回按请求身份分别收敛。 */
export declare class BubbleStore {
    private readonly transport;
    private readonly t;
    private snapshot;
    private readonly listeners;
    private readonly active;
    private readonly closing;
    private readonly notStarted;
    private readonly runEnd;
    private readonly closeFenced;
    private readonly admitting;
    private readonly hydrated;
    private readonly sessions;
    private disposed;
    private hydrating;
    /** 服务端是否支持多轮；由 probe() 显式确认，默认乐观显示。 */
    private multiturn;
    private probed;
    private probing;
    constructor(transport: SideTransport, t?: BtwTranslate);
    getSnapshot: () => readonly Bubble[];
    subscribe: (listener: () => void) => (() => void);
    /** 宿主是否提供追问通道；旧宿主/旧客户端自动隐藏追问输入框。 */
    get supportsReply(): boolean;
    /**
     * CommandResult 只保留 kind/text，因此能力标记不能搭 btw-run 的返回顺风车。
     * Dock 挂载时调用一次隐藏命令；旧服务端不认识时翻译成 false。
     */
    probe(sessionId: string): Promise<void>;
    /** 返回已接收请求的标识；满额先等待旧气泡关闭，失败时拒绝且不发送新问题。 */
    ask(sessionId: string, question: string, reference?: string): Promise<string>;
    /**
     * 向同一气泡投递追问。上一轮失败/取消时替换该轮（重试），否则追加新一轮。
     * 校验失败直接抛错；传输错误写进轮次状态，气泡保留可继续重试。
     */
    reply(sessionId: string, id: string, text: string, reference?: string): Promise<number>;
    /** 只停止当前轮；气泡与历史保留，可以立即重试。 */
    stop(id: string): void;
    close(id: string): Promise<void>;
    /** 刷新后恢复同一会话的气泡历史（只读文本 + 可继续追问）。 */
    hydrate(sessionId: string): void;
    dispose(): Promise<void>;
    private isActive;
    private abort;
    private completeTurn;
    private failTurn;
    private dropIfCloseCannotFinish;
    private remove;
    private update;
    private publish;
    private storageKey;
    private persist;
    private read;
}
