export type InstallPhase = "idle" | "installing" | "success" | "error";
export interface PackageInstallState {
    phase: InstallPhase;
    message: string;
    error: string | null;
}
export declare function usePackageInstall(): {
    install: (source: string) => Promise<void>;
    reset: () => void;
    phase: InstallPhase;
    message: string;
    error: string | null;
};
