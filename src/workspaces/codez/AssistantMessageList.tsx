import { memo, useMemo, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { JournalFileDiff } from "../../services/tauri/chat";
import TaskCard from "../../components/TaskCard";
import FileDiffCard from "../../components/FileDiffCard";
import InteractiveCard from "../../components/chat/InteractiveCard";
import type { InteractiveCardState } from "../../hooks/useInteractiveCards";
import Markdown from "./Markdown";

export interface AssistantChatMessage {
  id?: string;
  role: "user" | "assistant";
  text: string;
  turnId?: string;
}

interface AssistantMessageListProps {
  messages: AssistantChatMessage[];
  turnDiffsByTurnId: Record<string, JournalFileDiff[]>;
  busy: boolean;
  queuedView: string[];
  pendingCards: InteractiveCardState[];
  scrollRef: RefObject<HTMLDivElement>;
  onSelectPath?: (path: string) => void;
  onForkCheckpoint: (messageId: string) => void | Promise<void>;
  onRestoreCheckpoint: (messageId: string) => void | Promise<void>;
  onCardSubmitted: (requestId: string) => void;
  onCardActionSent: (requestId: string) => void;
  onPlanModeEnter?: () => void;
  onPlanBuild?: (planPath: string) => void;
}

/** Isolated from composer input state so keystrokes do not re-render markdown. */
function AssistantMessageList({
  messages,
  turnDiffsByTurnId,
  busy,
  queuedView,
  pendingCards,
  scrollRef,
  onSelectPath,
  onForkCheckpoint,
  onRestoreCheckpoint,
  onCardSubmitted,
  onCardActionSent,
  onPlanModeEnter,
  onPlanBuild,
}: AssistantMessageListProps) {
  const { t } = useTranslation();

  const lastUserMessageIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].text.trim()) return i;
    }
    return -1;
  }, [messages]);

  return (
    <div className="agentz-assistant-messages" ref={scrollRef}>
      {messages.length === 0 && <div className="agentz-assistant-empty">{t("chat.empty")}</div>}
      {messages.map((m, i) => {
        if (m.role === "user") {
          return (
            <div key={m.id ?? `msg-${i}`} className="agentz-turn-user agentz-msg-virtual">
              <TaskCard text={m.text} sticky={i === lastUserMessageIndex} />
            </div>
          );
        }

        const isStreamingLast = busy && i === messages.length - 1;
        const showCheckpoint = m.id && m.text.trim() && !isStreamingLast;
        const diffs = m.turnId ? turnDiffsByTurnId[m.turnId] : undefined;

          return (
            <div key={m.id ?? `msg-${i}`} className="agentz-msg assistant agentz-msg-virtual">
              {m.text ? (
                isStreamingLast ? (
                  <pre className="agentz-msg-text agentz-streaming">{m.text}</pre>
                ) : (
                  <Markdown content={m.text} />
                )
              ) : isStreamingLast ? (
                <div className="agentz-msg-text agentz-thinking">{t("chat.thinking")}</div>
              ) : null}
            {diffs && diffs.length > 0 && (
              <div className="agentz-turn-diffs">
                {diffs.map((d) => (
                  <FileDiffCard key={d.id} diff={d} onOpen={onSelectPath} />
                ))}
              </div>
            )}
            {showCheckpoint && (
              <div className="agentz-checkpoint">
                <span className="agentz-checkpoint-label">{t("chat.checkpoint")}</span>
                <button
                  type="button"
                  className="agentz-checkpoint-btn"
                  onClick={() => void onForkCheckpoint(m.id!)}
                  title={t("chat.checkpointFork")}
                >
                  {t("chat.checkpointFork")}
                </button>
                <button
                  type="button"
                  className="agentz-checkpoint-btn muted"
                  onClick={() => void onRestoreCheckpoint(m.id!)}
                  title={t("chat.checkpointRestore")}
                >
                  {t("chat.checkpointRestore")}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {queuedView.map((q, i) => (
        <div key={`q-${i}`} className="agentz-turn-user queued">
          <TaskCard text={q} />
        </div>
      ))}
      {pendingCards.map((card) => (
        <div key={card.requestId} className="agentz-msg assistant">
          <InteractiveCard
            requestId={card.requestId}
            uiDefinition={card.uiDefinition}
            listenOpen={card.listenOpen}
            wizardStepHint={card.wizardStepHint}
            onSubmitted={() => onCardSubmitted(card.requestId)}
            onActionSent={() => onCardActionSent(card.requestId)}
            onPlanModeEnter={onPlanModeEnter}
            onPlanBuild={onPlanBuild}
          />
        </div>
      ))}
    </div>
  );
}

export default memo(AssistantMessageList);
