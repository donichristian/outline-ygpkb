import { observer } from "mobx-react";
import * as React from "react";
import { SparklesIcon } from "outline-icons";
import { depths } from "@shared/styles";
import { useAIChatPanel } from "./AIChatContext";
import Button from "../Button";
import Tooltip from "../Tooltip";

/**
 * Floating trigger button for the AI chat panel.
 * Renders only when AI chat is enabled for the team and the panel is not already open.
 * Clicking opens the panel via the existing right-sidebar mechanism.
 */
export function AIChatTrigger() {
  const controls = useAIChatPanel();

  // If AI chat is disabled for the team, render nothing
  if (!controls) {
    return null;
  }

  // If the panel is already open, hide the trigger
  if (controls.isOpen) {
    return null;
  }

  return (
    <Tooltip content="AI chat" side="top" sideOffset={8}>
      <Button
        icon={<SparklesIcon />}
        neutral
        borderOnHover
        onClick={() => controls.open()}
        data-testid="ai-chat-trigger"
        style={{
          position: "fixed",
          right: 24,
          bottom: 24,
          zIndex: depths.sidebar - 1, // 899, just below the sliding Aside (900)
          width: 40,
          height: 40,
          padding: 0,
        }}
      />
    </Tooltip>
  );
}

export default observer(AIChatTrigger);
