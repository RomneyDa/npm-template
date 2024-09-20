import { DependencyInstallation, InstallationPlan, Dependency } from "../../types";
import semver from 'semver';
import path from 'path';
import fs from 'fs';
import { outputDir } from '../../util/paths';

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

  // Cache file path
  const cacheFilePath = path.join(outputDir, 'packageInfoCache.json');

  // Initialize packageInfoCache from file
  const packageInfoCache = new Map<string, any>();
  if (fs.existsSync(cacheFilePath)) {
    try {
      const cacheData = fs.readFileSync(cacheFilePath, 'utf8');
      const cacheJson = JSON.parse(cacheData);
      for (const [key, value] of Object.entries(cacheJson)) {
        packageInfoCache.set(key, value);
      }
    } catch (error) {
      console.error('Error reading cache file:', error);
    }
  }

  // Function to fetch package metadata with caching
  async function getCachedPackageInfo(packageName: string): Promise<any> {
    if (packageInfoCache.has(packageName)) {
      return packageInfoCache.get(packageName);
    } else {
      // Introduce a delay to avoid rate limiting
      await new Promise(res => setTimeout(res, 100));

      // Fetch only the 'versions' field to get all available versions and their dependencies
      console.log(`Fetching package info for ${packageName}`)
      const resp = await fetch(
        `https://registry.npmjs.org/${packageName}`,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.npm.install-v1+json", // Use a custom Accept header to get minimal metadata
          },
        }
      );
      if (resp.status !== 200) {
        throw new Error(`Failed to fetch metadata for package ${packageName}`);
      }
      const data = await resp.json();

      // Extract only the versions and their dependencies
      const minimalData = {
        versions: {} as Record<string, any>,
      };
      for (const [version, versionData] of Object.entries<any>(data.versions)) {
        minimalData.versions[version] = {
          dependencies: versionData.dependencies || {},
        };
      }

      packageInfoCache.set(packageName, minimalData);

      // Write cache to file
      try {
        const cacheJson = Object.fromEntries(packageInfoCache);
        fs.writeFileSync(cacheFilePath, JSON.stringify(cacheJson, null, 2), 'utf8');
      } catch (error) {
        console.error('Error writing to cache file:', error);
      }

      return minimalData;
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

  return installationPlan;
}
