import { observer } from "mobx-react";
import { BackIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s, ellipsis } from "@shared/styles";
import depths from "@shared/styles/depths";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import { HEADER_HEIGHT } from "~/components/Header";
import { PortalContext } from "~/components/Portal";
import { RightSidebarWrappedContext } from "~/components/RightSidebarContext";
import Scrollable from "~/components/Scrollable";
import Aside from "~/components/Sidebar/Aside";
import Tooltip from "~/components/Tooltip";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "~/components/primitives/Drawer";
import useMobile from "~/hooks/useMobile";
import { draggableOnDesktop } from "~/styles";

type Props = Omit<React.HTMLAttributes<HTMLDivElement>, "title"> & {
  /* The title of the sidebar */
  title: React.ReactNode;
  /* The content of the sidebar */
  children: React.ReactNode;
  /* Called when the sidebar is closed */
  onClose?: () => void;
  /* Whether the sidebar should be scrollable */
  scrollable?: boolean;
  /* Controls rendered at the trailing end of the header, before the close button */
  actions?: React.ReactNode;
  /* When true, cover the whole viewport instead of docking to the sidebar edge */
  fullscreen?: boolean;
};

function SidebarLayout({
  title,
  onClose,
  children,
  scrollable = true,
  actions,
  fullscreen = false,
}: Props) {
  const { t } = useTranslation();
  const isMobile = useMobile();
  const isWrapped = React.useContext(RightSidebarWrappedContext);
  const [drawerElement, setDrawerElement] =
    React.useState<HTMLDivElement | null>(null);

  const content = scrollable ? (
    <Scrollable hiddenScrollbars topShadow>
      {children}
    </Scrollable>
  ) : (
    children
  );

  if (isMobile) {
    return (
      <Drawer onClose={onClose} defaultOpen>
        <DrawerContent ref={setDrawerElement}>
          <DrawerTitle>{title}</DrawerTitle>
          <PortalContext.Provider value={drawerElement}>
            {content}
          </PortalContext.Provider>
        </DrawerContent>
      </Drawer>
    );
  }

  const inner = (
    <>
      <Header>
        <Title>{title}</Title>
        {actions && <Actions>{actions}</Actions>}
        <Tooltip content={t("Close")} shortcut="Esc">
          <Button
            icon={<ForwardIcon />}
            onClick={onClose}
            borderOnHover
            neutral
          />
        </Tooltip>
      </Header>
      {content}
    </>
  );

  if (fullscreen) {
    return <FullscreenRoot role="complementary">{inner}</FullscreenRoot>;
  }

  if (isWrapped) {
    return inner;
  }

  return <Aside>{inner}</Aside>;
}

const FullscreenRoot = styled.div`
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: ${s("background")};
  /* Above the docked sidebars, below menus/popovers/tooltips so the header's
     controls still layer over the panel. */
  z-index: ${depths.overlay};

  /* The header stays put; the panel body takes the rest and scrolls itself. */
  > *:last-child {
    flex: 1;
    min-height: 0;
  }
`;

const ForwardIcon = styled(BackIcon)`
  transform: rotate(180deg);
  flex-shrink: 0;

  [dir="rtl"] & {
    transform: rotate(0deg);
  }
`;

const Title = styled(Flex)`
  ${ellipsis()}
  font-size: 16px;
  font-weight: 600;
  text-align: center;
  align-items: center;
  justify-content: flex-start;
  user-select: none;
  width: 0;
  flex-grow: 1;
`;

const Header = styled(Flex)`
  ${draggableOnDesktop()}
  align-items: center;
  position: relative;
  padding-block: 12px;
  padding-inline: 16px 12px;
  min-height: ${HEADER_HEIGHT}px;
  color: ${s("text")};
  flex-shrink: 0;
`;

const Actions = styled(Flex)`
  align-items: center;
  flex-shrink: 0;
`;

export default observer(SidebarLayout);
