import { useCallback, useMemo, useState } from "react";
import type { AgentEvent } from "../services/tauri/chat";
import { applyUiPatch } from "../components/chat/interactiveUi/patch";
import type { UiDefinition, UiPatch } from "../components/chat/interactiveUi/protocol";

export interface InteractiveCardState {
  requestId: string;
  uiDefinition: UiDefinition;
  submitted?: boolean;
  listenOpen?: boolean;
  wizardStepHint?: number;
}

export function useInteractiveCards() {
  const [cards, setCards] = useState<Record<string, InteractiveCardState>>({});

  const handleAgentEvent = useCallback((evt: AgentEvent) => {
    switch (evt.type) {
      case "interactive_ui":
        setCards((prev) => ({
          ...prev,
          [evt.request_id]: {
            requestId: evt.request_id,
            uiDefinition: evt.ui_definition as UiDefinition,
            listenOpen: false,
          },
        }));
        break;
      case "interactive_ui_patch": {
        const patch = evt.patch as UiPatch;
        setCards((prev) => {
          const card = prev[evt.request_id];
          if (!card) return prev;
          return {
            ...prev,
            [evt.request_id]: {
              ...card,
              uiDefinition: applyUiPatch(card.uiDefinition, patch),
              listenOpen: patch.reopen_submit === true ? true : card.listenOpen,
              wizardStepHint: patch.wizard_step ?? card.wizardStepHint,
            },
          };
        });
        break;
      }
      case "interactive_ui_listen":
        setCards((prev) => {
          const card = prev[evt.request_id];
          if (!card) return prev;
          return {
            ...prev,
            [evt.request_id]: { ...card, listenOpen: true },
          };
        });
        break;
      case "done":
      case "cancelled":
        setCards({});
        break;
      default:
        break;
    }
  }, []);

  const pendingCards = useMemo(
    () => Object.values(cards).filter((c) => !c.submitted),
    [cards],
  );

  const markSubmitted = useCallback((requestId: string) => {
    setCards((prev) => {
      const card = prev[requestId];
      if (!card) return prev;
      return {
        ...prev,
        [requestId]: { ...card, submitted: true, listenOpen: false },
      };
    });
  }, []);

  const markActionSent = useCallback((requestId: string) => {
    setCards((prev) => {
      const card = prev[requestId];
      if (!card) return prev;
      return {
        ...prev,
        [requestId]: { ...card, listenOpen: false },
      };
    });
  }, []);

  const clearCards = useCallback(() => setCards({}), []);

  return {
    pendingCards,
    handleAgentEvent,
    markSubmitted,
    markActionSent,
    clearCards,
  };
}
