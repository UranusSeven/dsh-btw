import React from 'react';
import type { Bubble, BubbleStore } from './bubbles';
import type { BtwTranslate } from '../locales';
/** 多轮气泡复制为一份可直接粘贴的 Markdown 记录；单轮保持只复制答案文本。 */
export declare function transcriptOf(item: Bubble): string;
export declare function FollowUpComposer({ busy, limitReached, initialValue, onSend, onEscape, t }: {
    busy: boolean;
    limitReached: boolean;
    initialValue: string;
    onSend: (text: string) => Promise<unknown>;
    onEscape?: () => void;
    t: BtwTranslate;
}): React.JSX.Element;
export declare function BubbleView({ item, close, stop, reply, restart, t, collapsed, onToggleCollapse, maxTurns }: {
    item: Bubble;
    close: () => void;
    stop?: () => void;
    reply?: (text: string) => Promise<unknown>;
    restart?: (text: string) => Promise<unknown>;
    t: BtwTranslate;
    collapsed: boolean;
    onToggleCollapse: () => void;
    maxTurns?: number;
}): React.JSX.Element;
export declare function BubbleDock({ store, sessionId, t }: {
    store: BubbleStore;
    sessionId: string;
    t: BtwTranslate;
}): React.JSX.Element | null;
