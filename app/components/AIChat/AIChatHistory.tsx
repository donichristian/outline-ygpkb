import { observer } from "mobx-react";
import { HistoryIcon, PlusIcon, TrashIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s, ellipsis } from "@shared/styles";
import { dateLocale, dateToRelative } from "@shared/utils/date";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import NudeButton from "~/components/NudeButton";
import Text from "~/components/Text";
import Tooltip from "~/components/Tooltip";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "~/components/primitives/Popover";
import useCurrentUser from "~/hooks/useCurrentUser";
import useMobile from "~/hooks/useMobile";
import useStores from "~/hooks/useStores";
import type AIChatSession from "~/models/AIChatSession";

type Props = {
  /** The session whose conversation is currently displayed, if any. */
  activeSessionId: string | null;
  /** Called when a session is chosen from the list. */
  onSelect: (sessionId: string) => void;
  /** Called when a fresh conversation should be started. */
  onNewChat: () => void;
};

/**
 * The history of AI chat conversations, as a dropdown anchored in the panel
 * header. Lists the current user's sessions most recently updated first, with a
 * "New chat" action and a per-session delete.
 *
 * Delete is a two-step disclosure rather than a modal: the action turns into a
 * confirmation in place, so a session cannot be destroyed by a single click, and
 * the whole flow stays inside a component that is never remounted by the
 * sidebar's render loop. The dropdown itself reflects `sessionsByRecency` –
 * derived from the store's `data` map, which `list()` replaces wholesale – so a
 * session deleted here or on another device cannot reappear from the IndexedDB
 * cache.
 */
const AIChatHistory = observer(function AIChatHistory({
  activeSessionId,
  onSelect,
  onNewChat,
}: Props) {
  const { t } = useTranslation();
  const { aiChatSessions } = useStores();
  const user = useCurrentUser({ rejectOnEmpty: false });
  const isMobile = useMobile();
  const [open, setOpen] = React.useState(false);
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const locale = dateLocale(user?.language);

  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    // Leaving the dropdown abandons any half-asked question, so a confirmation
    // can always be dismissed by clicking away.
    setConfirmingId(null);
  }, []);

  const handleSelect = React.useCallback(
    (sessionId: string) => {
      onSelect(sessionId);
      setOpen(false);
    },
    [onSelect]
  );

  const handleNewChat = React.useCallback(() => {
    onNewChat();
    setOpen(false);
  }, [onNewChat]);

  const handleConfirmDelete = React.useCallback(
    async (session: AIChatSession) => {
      setDeletingId(session.id);

      try {
        await aiChatSessions.delete(session);
        // The deleted conversation is the one on screen, so there is nothing
        // left to display: start a fresh one instead of leaving the panel
        // pointed at a session that no longer exists.
        if (session.id === activeSessionId) {
          onNewChat();
        }
      } finally {
        setDeletingId(null);
        setConfirmingId(null);
      }
    },
    [aiChatSessions, activeSessionId, onNewChat]
  );

  const sessions = aiChatSessions.sessionsByRecency;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger>
        <NudeButton
          aria-label={t("Chat history")}
          data-testid="ai-chat-history-trigger"
          type="button"
        >
          <Tooltip content={t("Chat history")} placement="bottom">
            <HistoryIcon size={18} />
          </Tooltip>
        </NudeButton>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t("Chat history")}
        side={isMobile ? "bottom" : "bottom"}
        align={isMobile ? "center" : "start"}
        shrink
        scrollable={false}
        width={300}
      >
        <Flex column>
          <MenuHeader>
            <Text type="secondary" size="xsmall" weight="xbold">
              {t("Chat history")}
            </Text>
          </MenuHeader>

          <NewChatButton
            type="button"
            neutral
            onClick={handleNewChat}
            data-testid="ai-chat-new"
          >
            <PlusIcon size={16} />
            <NewChatLabel>{t("New chat")}</NewChatLabel>
          </NewChatButton>

          {sessions.length === 0 ? (
            <EmptyHint type="secondary" size="small">
              {t("Your conversations will appear here")}
            </EmptyHint>
          ) : (
            <SessionList>
              {sessions.map((session) => {
                const title = session.title
                  ? session.title
                  : t("Untitled chat");
                const isActive = session.id === activeSessionId;
                const isConfirming = session.id === confirmingId;
                const isDeleting = session.id === deletingId;

                return (
                  <Row key={session.id} column>
                    <RowButton
                      type="button"
                      $active={isActive}
                      onClick={() => handleSelect(session.id)}
                      aria-current={isActive ? "true" : undefined}
                      data-testid={`ai-chat-session-${session.id}`}
                    >
                      <RowTitle $active={isActive}>{title}</RowTitle>
                      <RowSubtitle type="secondary" size="xsmall">
                        {dateToRelative(Date.parse(session.updatedAt), {
                          addSuffix: true,
                          locale,
                        })}
                      </RowSubtitle>
                    </RowButton>

                    {isConfirming ? (
                      <ConfirmBar gap={8} align="center">
                        <Text type="secondary" size="xsmall">
                          {t("Delete this chat?")}
                        </Text>
                        <Button
                          type="button"
                          danger
                          borderOnHover
                          neutral
                          disabled={isDeleting}
                          onClick={() => void handleConfirmDelete(session)}
                          data-testid={`ai-chat-delete-confirm-${session.id}`}
                        >
                          {isDeleting ? t("Deleting") : t("Delete")}
                        </Button>
                        <NudeButton
                          type="button"
                          disabled={isDeleting}
                          onClick={() => setConfirmingId(null)}
                          data-testid={`ai-chat-delete-cancel-${session.id}`}
                        >
                          <Text type="secondary" size="xsmall">
                            {t("Cancel")}
                          </Text>
                        </NudeButton>
                      </ConfirmBar>
                    ) : (
                      <DeleteButton
                        type="button"
                        onClick={() => setConfirmingId(session.id)}
                        aria-label={t("Delete chat")}
                        data-testid={`ai-chat-delete-${session.id}`}
                      >
                        <Tooltip content={t("Delete chat")} placement="bottom">
                          <TrashIcon size={15} />
                        </Tooltip>
                      </DeleteButton>
                    )}
                  </Row>
                );
              })}
            </SessionList>
          )}
        </Flex>
      </PopoverContent>
    </Popover>
  );
});

const MenuHeader = styled(Flex)`
  padding: 0 4px 6px;
`;

const NewChatButton = styled(Button)`
  justify-content: flex-start;
  margin: 0 4px 6px;
  width: calc(100% - 8px);
`;

const NewChatLabel = styled.span`
  font-weight: 500;
`;

const SessionList = styled(Flex)`
  margin: 0 -4px;
  max-height: 45vh;
  overflow-y: auto;
  overscroll-behavior: none;
`;

const Row = styled(Flex)`
  position: relative;
  border-radius: 6px;

  &:hover,
  &:focus-within {
    background: ${s("backgroundSecondary")};
  }
`;

const RowButton = styled.button<{ $active: boolean }>`
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex-grow: 1;
  min-width: 0;
  padding: 6px 30px 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: var(--pointer);
  color: ${s("text")};

  &:focus-visible {
    outline: none;
  }

  ${(props) =>
    props.$active &&
    `background: ${props.theme.sidebarActiveBackground}; font-weight: 600;`}
`;

const RowTitle = styled.div<{ $active: boolean }>`
  ${ellipsis()}
  font-size: 14px;
  font-weight: ${(props) => (props.$active ? 600 : 500)};
`;

const RowSubtitle = styled(Text)`
  ${ellipsis()}
`;

const DeleteButton = styled(NudeButton)`
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  inset-inline-end: 4px;
  color: ${s("textTertiary")};
  opacity: 0;

  ${Row}:hover &,
  ${Row}:focus-within & {
    opacity: 1;
  }
`;

const ConfirmBar = styled(Flex)`
  padding: 2px 6px 6px 8px;
  flex-wrap: wrap;
`;

const EmptyHint = styled(Text)`
  padding: 6px 8px;
`;

export default AIChatHistory;
