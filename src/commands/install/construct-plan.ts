import { DependencyInstallation, InstallationPlan, Dependency } from "../../types";
import semver from 'semver';
import path from 'path';

interface PackageVersionInfo {
  count: number;
  parentDirectories: string[];
}

/**
 *
 * @param topLevelDependencies The list of dependencies as determined by package.json's `dependencies` object
 * @returns The installation plan
 */
export async function constructInstallationPlan(
  topLevelDependencies: Record<string, string>
): Promise<InstallationPlan> {
  const installationPlan: InstallationPlan = [];
  const dependencyMap = new Map<string, {
    name: string;
    versionRange: string;
    parentDirectory: string | undefined;
  }>();
  const packageInfoCache = new Map<string, any>();
  const versionUsageCount = new Map<string, PackageVersionInfo>();

  // Function to fetch package metadata with caching
  async function getCachedPackageInfo(packageName: string): Promise<any> {
    if (packageInfoCache.has(packageName)) {
      return packageInfoCache.get(packageName);
    } else {
      console.log(`Getting package info for ${packageName}`);
      const resp = await fetch(
        `https://registry.npmjs.org/${packageName}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        }
      );

      if (resp.status !== 200) {
        throw new Error(`Failed to fetch metadata for package ${packageName}`);
      }

      const allData = await resp.json() as {
        versions: { [key: string]: { dependencies: Record<string, string> } },
      };

      const relevantData = {
        versions: Object.fromEntries(Object.keys(allData.versions).map(k => {
          const version = allData.versions[k];
          const dependencies = version.dependencies;
          return [k, { dependencies }];
        })),
      };

      packageInfoCache.set(packageName, relevantData);
      console.log(`Package info for ${packageName}:\n${JSON.stringify(relevantData, null, 4)}`);

      return relevantData;
    }
  }

  // Function to resolve the maximum satisfying version
  function resolveVersion(versions: string[], range: string): string {
    const maxSatisfyingVersion = semver.maxSatisfying(versions, range);
    if (!maxSatisfyingVersion) {
      throw new Error(`Could not find a version for ${range}`);
    }
    return maxSatisfyingVersion;
  }

  // Function to process a single dependency
  async function processDependency(
    dep: Dependency,
    parentDirectory?: string
  ) {
    const depKey = `${parentDirectory || 'root'}##${dep.name}`;
    if (dependencyMap.has(depKey)) {
      // Merge version ranges
      const existing = dependencyMap.get(depKey)!;
      existing.versionRange = semver.validRange(
        `${existing.versionRange} || ${dep.version}`
      )!;
      return;
    } else {
      dependencyMap.set(depKey, {
        name: dep.name,
        versionRange: dep.version,
        parentDirectory,
      });
    }

    // Fetch package info once
    const packageInfo = await getCachedPackageInfo(dep.name);
    const allVersions = Object.keys(packageInfo.versions);

    // Resolve the version
    const resolvedVersion = resolveVersion(allVersions, dep.version);

    // Get the dependencies for the resolved version
    const versionInfo = packageInfo.versions[resolvedVersion];
    const dependencies = versionInfo.dependencies || {};

    // Track version usage
    const versionCountKey = `${dep.name}@${resolvedVersion}`;
    if (!versionUsageCount.has(versionCountKey)) {
      versionUsageCount.set(versionCountKey, { count: 0, parentDirectories: [] });
    }
    const usageInfo = versionUsageCount.get(versionCountKey)!;
    usageInfo.count++;
    usageInfo.parentDirectories.push(parentDirectory || 'root');

    // Add to installation plan
    installationPlan.push({
      name: dep.name,
      version: resolvedVersion,
      parentDirectory,
    });

    // Process child dependencies
    const childDeps = Object.entries(dependencies);
    for (const [childName, childVersionRange] of childDeps) {
      const childDep: Dependency = {
        name: childName,
        version: childVersionRange as string,
      };

      const childParentDirectory = parentDirectory
        ? path.join(parentDirectory, 'node_modules', dep.name)
        : dep.name;

      await processDependency(childDep, childParentDirectory);
    }
  }

  // Process top-level dependencies
  for (const [name, versionRange] of Object.entries(topLevelDependencies)) {
    await processDependency({ name, version: versionRange });
  }

  // Elevate the most used versions to the root node_modules
  for (const [pkgVersion, info] of versionUsageCount.entries()) {
    const [name, version] = pkgVersion.split('@');
    const rootParentDirectory = 'root';
    const existingPlanItem = installationPlan.find(
      item => item.name === name && item.version === version && item.parentDirectory === rootParentDirectory
    );

    // Add to the plan if not already present at the root
    if (!existingPlanItem) {
      installationPlan.push({
        name,
        version,
        parentDirectory: rootParentDirectory,
      });
    }
  }

  return installationPlan;
}
