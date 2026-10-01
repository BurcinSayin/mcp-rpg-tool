export interface SemverParsed {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  build?: string;
}

export interface ValidatedReleaseTag {
  tag: string;
  version: string;
  isPrerelease: boolean;
  distTag: string;
}

export interface DefaultBranchAncestryResult {
  gitRef: string;
  targetBranch: string;
}

export interface FileChecksums {
  sha256: string;
  shasum: string;
  sizeBytes: number;
}

export interface ReleaseNotesOptions {
  version: string;
  packageName: string;
  tarballFilename: string;
  sha256: string;
  isPrerelease: boolean;
  distTag: string;
}

export type NpmPublicationStatus =
  | { status: 'not_published' }
  | { status: 'already_published_match'; publishedShasum: string }
  | { status: 'already_published_mismatch'; publishedShasum: string, localShasum: string };

export interface PackedPackageResult extends FileChecksums {
  filename: string;
  filePath: string;
}

export function parseSemver(versionStr: string): SemverParsed | null;

export function validateReleaseTag(
  tag: string,
  packageVersion: string,
  serverVersion?: string
): ValidatedReleaseTag;

export function resolveReleaseTag(
  packageVersion: string,
  options?: {
    explicitTag?: string;
    serverVersion?: string;
    githubActions?: string;
    githubRefType?: string;
    githubRefName?: string;
    isDryRun?: boolean;
    isNonPublishing?: boolean;
  }
): ValidatedReleaseTag;

export function verifyDefaultBranchAncestry(
  gitRef?: string,
  defaultBranch?: string,
  execFn?: (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>
): Promise<DefaultBranchAncestryResult>;

export function computeFileChecksums(filePath: string): FileChecksums;

export function generateReleaseNotes(options: ReleaseNotesOptions): string;

export function checkNpmPublicationStatus(
  packageName: string,
  version: string,
  localShasum: string,
  execFn?: (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>
): Promise<NpmPublicationStatus>;

export function packPackage(
  destinationDir?: string,
  execFn?: (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>
): Promise<PackedPackageResult>;

export function main(argv?: string[]): Promise<void>;

export const PROJECT_ROOT: string;
