interface Props {
    /** CWD of the session this popover is anchored to. */
    cwd?: string;
    /** Called to close the popover. */
    onClose?: () => void;
}
export declare function HonchoMapPopover({ cwd, onClose }: Props): import("react/jsx-runtime").JSX.Element | null;
export {};
