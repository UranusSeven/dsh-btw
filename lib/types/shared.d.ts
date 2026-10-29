export { MAX_QUESTION_LENGTH, MAX_REFERENCE_LENGTH, MAX_TOTAL_QUOTES_LENGTH } from './limits';
import { type BtwLocale } from './locales';
export declare const RUN_COMMAND = "btw-run";
export declare const CLOSE_COMMAND = "btw-close";
export declare const REPLY_COMMAND = "btw-reply";
export declare const STOP_COMMAND = "btw-stop";
export declare const CAPABILITIES_COMMAND = "btw-capabilities";
export interface SideRequest {
    id: string;
    question: string;
    locale: BtwLocale;
    reference?: string;
}
/** 追问请求：turn 由客户端递增，用于幂等与乱序检测。 */
export interface SideReplyRequest {
    id: string;
    kind: 'reply';
    turn: number;
    text: string;
    locale: BtwLocale;
    reference?: string;
}
export interface SideResult {
    kind: 'success' | 'error';
    text: string;
    /**
     * 该轮已生成的可见文本。取消或模型截断时保留，客户端据此展示半成品答案，
     * 而不是把整轮内容丢弃。成功结果不使用该字段。
     */
    partial?: string;
    /** 服务端确认该气泡支持多轮追问；旧服务端不返回此字段，客户端自动隐藏追问框。 */
    multiturn?: boolean;
}
/** 内部命令使用结构化请求，身份始终由宿主会话提供。 */
export declare function parseRequest(raw: string): SideRequest;
/** 追问请求复用同一套长度与标识校验，额外要求 turn 为正整数。 */
export declare function parseReplyRequest(raw: string): SideReplyRequest;
/** 引用是待解释的数据，不能作为替代问题或执行指令。 */
export declare function questionWithReference(question: string, reference?: string, locale?: BtwLocale): string;
