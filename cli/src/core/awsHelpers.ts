// @ts-nocheck

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createAwsHelpers(deps: Record<string, any>) {
  const {
    DEFAULT_REGION,
    DEFAULT_WORKSPACE_MOUNT,
    LOCAL_SSH_MOUNT,
    SECURITY_GROUP_ID_RE,
    SUBNET_ID_RE,
    DEVBOX_SECURITY_GROUP_OUTPUT_KEYS,
    GENERIC_SECURITY_GROUP_OUTPUT_KEYS,
    DEVBOX_SUBNET_OUTPUT_KEYS,
    GENERIC_SUBNET_OUTPUT_KEYS,
    API_URL_CACHE_TTL_SECONDS,
    USER_ID_CACHE_TTL_SECONDS,
    RuntimeError,
    CommandError,
    MissingCommandError,
    run,
    isFile,
    expandUser,
    cacheGet,
    cacheSet,
    formatAmzDate,
    formatAmzDateStamp,
  } = deps;

  function awsCmd(
    args: string[],
    profile?: string,
    region?: string,
    captureOutput = true,
    check = true,
  ): CompletedProcess {
    const cmd = ["aws", "--no-cli-pager"];
    if (profile) {
      cmd.push("--profile", profile);
    }
    cmd.push(...args);
    if (region && !args.includes("--region")) {
      cmd.push("--region", region);
    }
  
    const env: NodeJS.ProcessEnv = { ...process.env, AWS_PAGER: "" };
    return run(cmd, { captureOutput, check, env });
  }
  
  function awsJson(args: string[], profile?: string, region?: string): AnyDict {
    const actualArgs = args.includes("--output") ? [...args] : [...args, "--output", "json"];
    const result = awsCmd(actualArgs, profile, region, true, true);
    if (!result.stdout) {
      return {};
    }
    return JSON.parse(result.stdout);
  }
  
  interface IniData {
    [section: string]: Record<string, string>;
  }
  
  function parseIni(content: string): IniData {
    const data: IniData = {};
    let currentSection = "";
    data[currentSection] = {};
  
    for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) {
        continue;
      }
  
      if (line.startsWith("[") && line.endsWith("]")) {
        currentSection = line.slice(1, -1).trim();
        if (!data[currentSection]) {
          data[currentSection] = {};
        }
        continue;
      }
  
      const eqIdx = line.indexOf("=");
      const colonIdx = line.indexOf(":");
      let sepIdx = -1;
      if (eqIdx >= 0 && colonIdx >= 0) {
        sepIdx = Math.min(eqIdx, colonIdx);
      } else {
        sepIdx = Math.max(eqIdx, colonIdx);
      }
  
      if (sepIdx < 0) {
        continue;
      }
  
      const key = line.slice(0, sepIdx).trim().toLowerCase();
      const value = line.slice(sepIdx + 1).trim();
      if (!data[currentSection]) {
        data[currentSection] = {};
      }
      data[currentSection][key] = value;
    }
  
    return data;
  }
  
  function normalizeAwsProfileName(profile: string): string {
    const normalized = profile.trim();
    if (normalized.startsWith("profile ")) {
      return normalized.slice("profile ".length).trim();
    }
    return normalized || "default";
  }
  
  const readRegionFromConfigCache = new Map<string, string | undefined>();
  const readAwsConfigSectionCache = new Map<string, Record<string, string>>();
  const readAwsCredentialsFileCache = new Map<
    string,
    { access_key: string; secret_key: string; session_token?: string } | undefined
  >();
  
  function readRegionFromAwsConfig(profile: string): string | undefined {
    if (readRegionFromConfigCache.has(profile)) {
      return readRegionFromConfigCache.get(profile);
    }
  
    const configPath = path.join(os.homedir(), ".aws", "config");
    if (!isFile(configPath)) {
      readRegionFromConfigCache.set(profile, undefined);
      return undefined;
    }
  
    let parsed: IniData;
    try {
      parsed = parseIni(fs.readFileSync(configPath, "utf8"));
    } catch {
      readRegionFromConfigCache.set(profile, undefined);
      return undefined;
    }
  
    const section = profile === "default" ? "default" : `profile ${profile}`;
    const region = parsed[section]?.region?.trim();
    const resolved = region || undefined;
    readRegionFromConfigCache.set(profile, resolved);
    return resolved;
  }
  
  function readAwsConfigSection(profile: string): Record<string, string> {
    if (readAwsConfigSectionCache.has(profile)) {
      return readAwsConfigSectionCache.get(profile) ?? {};
    }
  
    const configPath = path.join(os.homedir(), ".aws", "config");
    if (!isFile(configPath)) {
      readAwsConfigSectionCache.set(profile, {});
      return {};
    }
  
    let parsed: IniData;
    try {
      parsed = parseIni(fs.readFileSync(configPath, "utf8"));
    } catch {
      readAwsConfigSectionCache.set(profile, {});
      return {};
    }
  
    const section = profile === "default" ? "default" : `profile ${profile}`;
    const value = parsed[section] ?? {};
    readAwsConfigSectionCache.set(profile, value);
    return value;
  }
  
  function readAwsCredentialsFile(
    profile: string,
  ): { access_key: string; secret_key: string; session_token?: string } | undefined {
    if (readAwsCredentialsFileCache.has(profile)) {
      return readAwsCredentialsFileCache.get(profile);
    }
  
    const credentialsPath = path.join(os.homedir(), ".aws", "credentials");
    if (!isFile(credentialsPath)) {
      readAwsCredentialsFileCache.set(profile, undefined);
      return undefined;
    }
  
    let parsed: IniData;
    try {
      parsed = parseIni(fs.readFileSync(credentialsPath, "utf8"));
    } catch {
      readAwsCredentialsFileCache.set(profile, undefined);
      return undefined;
    }
  
    const section = profile === "default" ? "default" : profile;
    const sectionData = parsed[section];
    if (!sectionData) {
      readAwsCredentialsFileCache.set(profile, undefined);
      return undefined;
    }
  
    const accessKey = (sectionData.aws_access_key_id ?? "").trim();
    const secretKey = (sectionData.aws_secret_access_key ?? "").trim();
    const sessionToken = (sectionData.aws_session_token ?? "").trim() || undefined;
  
    if (!accessKey || !secretKey) {
      readAwsCredentialsFileCache.set(profile, undefined);
      return undefined;
    }
  
    const creds = { access_key: accessKey, secret_key: secretKey, session_token: sessionToken };
    readAwsCredentialsFileCache.set(profile, creds);
    return creds;
  }
  
  function resolveRegion(argRegion: string | undefined, profile: string | undefined): string {
    if (argRegion) {
      return argRegion;
    }
  
    const envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (envRegion) {
      return envRegion;
    }
  
    const profileName = normalizeAwsProfileName(profile || process.env.AWS_PROFILE || "default");
    const configuredRegion = readRegionFromAwsConfig(profileName);
    if (configuredRegion) {
      return configuredRegion;
    }
  
    return DEFAULT_REGION;
  }
  
  function resolveWorkspaceMount(
    workspaceMount: string | undefined,
    useLocalEnv: boolean,
    projectDir: string,
  ): string {
    if (workspaceMount) {
      return workspaceMount;
    }
    if (useLocalEnv) {
      return path.resolve(projectDir);
    }
    return DEFAULT_WORKSPACE_MOUNT;
  }
  
  function resolveSshMount(useLocalEnv: boolean): string {
    return useLocalEnv ? LOCAL_SSH_MOUNT : DEFAULT_SSH_MOUNT;
  }
  
  function isWsl(): boolean {
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
      return true;
    }
  
    try {
      const procVersion = fs.readFileSync("/proc/version", "utf8").toLowerCase();
      return procVersion.includes("microsoft");
    } catch {
      return false;
    }
  }
  
  function detectWindowsUserprofile(): string | undefined {
    let result: CompletedProcess;
    try {
      result = run(["cmd.exe", "/c", "echo", "%USERPROFILE%"]);
    } catch (error) {
      if (error instanceof MissingCommandError) {
        return undefined;
      }
      throw error;
    }
  
    const userprofile = result.stdout.trim();
    if (!userprofile || userprofile.includes("%")) {
      return undefined;
    }
    return userprofile;
  }
  
  function toWslPath(pathValue: string): string {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(pathValue);
    if (match) {
      const drive = match[1].toLowerCase();
      const rest = match[2].replace(/\\/g, "/");
      return path.join("/mnt", drive, rest);
    }
    return expandUser(pathValue);
  }
  
  const getUserIdRuntimeCache = new Map<string, string>();
  
  function getUserId(profile?: string): string {
    const profileName = normalizeAwsProfileName(profile || process.env.AWS_PROFILE || "default");
    if (getUserIdRuntimeCache.has(profileName)) {
      return getUserIdRuntimeCache.get(profileName) as string;
    }
  
    const cacheKey = `user_id:${profileName}`;
    const cached = cacheGet(cacheKey, USER_ID_CACHE_TTL_SECONDS);
    if (cached) {
      getUserIdRuntimeCache.set(profileName, cached);
      return cached;
    }
  
    try {
      const result = awsCmd(["sts", "get-caller-identity", "--query", "Arn", "--output", "text"], profile);
      const arn = result.stdout.trim();
      if (arn && arn !== "None") {
        const userId = arn.split("/").at(-1) ?? "";
        if (userId) {
          cacheSet(cacheKey, userId);
          getUserIdRuntimeCache.set(profileName, userId);
          return userId;
        }
      }
    } catch (error) {
      if (!(error instanceof CommandError)) {
        throw error;
      }
    }
  
    return process.env.USER || process.env.USERNAME || "unknown";
  }
  
  const getStackOutputsCache = new Map<string, AnyDict[]>();
  
  function getStackOutputs(profile: string | undefined, region: string, stackName: string): AnyDict[] {
    const cacheKey = `${profile ?? ""}|${region}|${stackName}`;
    if (getStackOutputsCache.has(cacheKey)) {
      return getStackOutputsCache.get(cacheKey) as AnyDict[];
    }
  
    const data = awsJson(["cloudformation", "describe-stacks", "--stack-name", stackName], profile, region);
    const stacks = Array.isArray(data.Stacks) ? data.Stacks : [];
    if (stacks.length === 0) {
      throw new RuntimeError(`Stack not found: ${stackName}`);
    }
  
    const outputs = Array.isArray(stacks[0].Outputs) ? stacks[0].Outputs : [];
    getStackOutputsCache.set(cacheKey, outputs);
    return outputs;
  }
  
  function getOutputValue(outputs: AnyDict[], key?: string, contains?: string): string {
    for (const output of outputs) {
      const outputKey = (output.OutputKey ?? "") as string;
      if (key && outputKey === key) {
        return (output.OutputValue ?? "") as string;
      }
      if (contains && outputKey.includes(contains)) {
        return (output.OutputValue ?? "") as string;
      }
    }
    return "";
  }
  
  function resolveApiUrlFromOutputs(outputs: AnyDict[]): string {
    const apiUrl = getOutputValue(outputs, undefined, "DevboxApiUrl");
    if (!apiUrl) {
      throw new RuntimeError("Devbox API URL not found in stack outputs");
    }
    return apiUrl;
  }
  
  function uniquePreserveOrder(items: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
    return result;
  }
  
  function extractIds(value: string, pattern: RegExp): string[] {
    if (!value) {
      return [];
    }
  
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      matches.push(m[0]);
    }
    return uniquePreserveOrder(matches);
  }
  
  function findOutputValueCi(outputs: AnyDict[], keys: string[]): string {
    for (const key of keys) {
      const value = getOutputValue(outputs, key);
      if (value) {
        return value;
      }
    }
  
    const lowered = keys.map((k) => k.toLowerCase());
    for (const output of outputs) {
      const outputKeyLower = String(output.OutputKey ?? "").toLowerCase();
      for (const key of lowered) {
        if (outputKeyLower.includes(key)) {
          const value = String(output.OutputValue ?? "");
          if (value) {
            return value;
          }
        }
      }
    }
  
    return "";
  }
  
  function findOutputValueDevboxHint(outputs: AnyDict[], tokens: string[]): string {
    for (const output of outputs) {
      const outputKeyLower = String(output.OutputKey ?? "").toLowerCase();
      if (!outputKeyLower.includes("devbox")) {
        continue;
      }
      if (!tokens.every((token) => outputKeyLower.includes(token))) {
        continue;
      }
  
      const value = String(output.OutputValue ?? "");
      if (value) {
        return value;
      }
    }
    return "";
  }
  
  function resolveSecurityGroupIds(
    outputs: AnyDict[],
    securityGroupId?: string,
    securityGroupIds?: string,
  ): string[] {
    if (securityGroupIds) {
      const ids = extractIds(securityGroupIds, SECURITY_GROUP_ID_RE);
      return ids.length > 0 ? ids : [securityGroupIds.trim()];
    }
  
    if (securityGroupId) {
      return [securityGroupId.trim()];
    }
  
    let value = findOutputValueCi(outputs, DEVBOX_SECURITY_GROUP_OUTPUT_KEYS);
    if (!value) {
      value = findOutputValueDevboxHint(outputs, ["security", "group"]);
    }
    if (!value) {
      value = findOutputValueCi(outputs, GENERIC_SECURITY_GROUP_OUTPUT_KEYS);
    }
  
    const ids = extractIds(value, SECURITY_GROUP_ID_RE);
    return ids.length > 0 ? ids : value ? [value.trim()] : [];
  }
  
  function resolveSubnetIds(outputs: AnyDict[], subnetId?: string): string[] {
    if (subnetId) {
      const ids = extractIds(subnetId, SUBNET_ID_RE);
      return ids.length > 0 ? ids : [subnetId.trim()];
    }
  
    let value = findOutputValueCi(outputs, DEVBOX_SUBNET_OUTPUT_KEYS);
    if (!value) {
      value = findOutputValueDevboxHint(outputs, ["subnet"]);
    }
    if (!value) {
      value = findOutputValueCi(outputs, GENERIC_SUBNET_OUTPUT_KEYS);
    }
  
    const ids = extractIds(value, SUBNET_ID_RE);
    return ids.length > 0 ? ids : value ? [value.trim()] : [];
  }
  
  function describeSubnetVpcs(subnetIds: string[], profile: string | undefined, region: string): AnyDict {
    if (subnetIds.length === 0) {
      return {};
    }
  
    const result = awsCmd(
      [
        "ec2",
        "describe-subnets",
        "--subnet-ids",
        ...subnetIds,
        "--query",
        "Subnets[*].{SubnetId:SubnetId,VpcId:VpcId}",
        "--output",
        "json",
      ],
      profile,
      region,
    );
  
    const data = result.stdout ? (JSON.parse(result.stdout) as AnyDict[]) : [];
    const mapping: AnyDict = {};
    for (const item of data) {
      if (item.SubnetId) {
        mapping[String(item.SubnetId)] = String(item.VpcId ?? "");
      }
    }
    return mapping;
  }
  
  function describeSecurityGroupVpcs(sgIds: string[], profile: string | undefined, region: string): AnyDict {
    if (sgIds.length === 0) {
      return {};
    }
  
    const result = awsCmd(
      [
        "ec2",
        "describe-security-groups",
        "--group-ids",
        ...sgIds,
        "--query",
        "SecurityGroups[*].{GroupId:GroupId,VpcId:VpcId}",
        "--output",
        "json",
      ],
      profile,
      region,
    );
  
    const data = result.stdout ? (JSON.parse(result.stdout) as AnyDict[]) : [];
    const mapping: AnyDict = {};
    for (const item of data) {
      if (item.GroupId) {
        mapping[String(item.GroupId)] = String(item.VpcId ?? "");
      }
    }
    return mapping;
  }
  
  function alignNetworkIds(
    sgIds: string[],
    subnetIds: string[],
    profile: string | undefined,
    region: string,
  ): [string[], string[]] {
    if (sgIds.length === 0 || subnetIds.length === 0) {
      return [sgIds, subnetIds];
    }
  
    let subnetVpcs: AnyDict;
    let sgVpcs: AnyDict;
    try {
      subnetVpcs = describeSubnetVpcs(subnetIds, profile, region);
      sgVpcs = describeSecurityGroupVpcs(sgIds, profile, region);
    } catch (error) {
      if (error instanceof CommandError || error instanceof SyntaxError) {
        return [sgIds, subnetIds];
      }
      throw error;
    }
  
    if (Object.keys(subnetVpcs).length === 0 || Object.keys(sgVpcs).length === 0) {
      return [sgIds, subnetIds];
    }
  
    for (const subnetId of subnetIds) {
      const subnetVpc = subnetVpcs[subnetId];
      if (!subnetVpc) {
        continue;
      }
      const matchingSgs = sgIds.filter((sg) => sgVpcs[sg] === subnetVpc);
      if (matchingSgs.length > 0) {
        if (
          matchingSgs.join("\0") !== sgIds.join("\0") ||
          subnetId !== subnetIds[0] ||
          subnetIds.length > 1
        ) {
          console.log(
            `Using subnet ${subnetId} with security groups ${matchingSgs.join(", ")} (matching VPC).`,
          );
        }
        return [matchingSgs, [subnetId]];
      }
    }
  
    const primarySubnet = subnetIds[0];
    const primaryVpc = subnetVpcs[primarySubnet];
    const sgVpcValues = new Set(Object.values(sgVpcs).filter(Boolean));
    if (primaryVpc && sgVpcValues.size > 0 && !sgVpcValues.has(primaryVpc)) {
      console.log(
        "Warning: resolved subnet and security groups are in different VPCs. " +
          "Provide matching --subnet-id/--security-group-id or update stack outputs.",
      );
    }
  
    return [sgIds, subnetIds];
  }
  
  function buildDevboxNetworkPayload(
    outputs: AnyDict[],
    args: AnyDict,
    profile: string | undefined,
    region: string,
  ): AnyDict {
    const payload: AnyDict = {};
    let sgIds = resolveSecurityGroupIds(outputs, args.security_group_id, args.security_group_ids);
    let subnetIds = resolveSubnetIds(outputs, args.subnet_id);
  
    [sgIds, subnetIds] = alignNetworkIds(sgIds, subnetIds, profile, region);
  
    if (sgIds.length > 0) {
      payload.securityGroupIds = sgIds;
      if (sgIds.length === 1) {
        payload.securityGroupId = sgIds[0];
      }
    }
  
    if (subnetIds.length > 0) {
      payload.subnetId = subnetIds[0];
      if (subnetIds.length > 1) {
        payload.subnetIds = subnetIds;
      }
    }
  
    return payload;
  }
  
  function getApiUrl(profile: string | undefined, region: string, stackName: string): string {
    const profileName = normalizeAwsProfileName(profile || process.env.AWS_PROFILE || "default");
    const cacheKey = `api_url:${profileName}:${region}:${stackName}`;
    const cached = cacheGet(cacheKey, API_URL_CACHE_TTL_SECONDS);
    if (cached) {
      return cached;
    }
  
    const outputs = getStackOutputs(profile, region, stackName);
    const apiUrl = resolveApiUrlFromOutputs(outputs);
    if (apiUrl) {
      cacheSet(cacheKey, apiUrl);
    }
    return apiUrl;
  }
  
  const awsCredentialsRuntimeCache = new Map<
    string,
    { access_key: string; secret_key: string; session_token?: string }
  >();
  
  function getAwsCredentials(profile?: string): {
    access_key: string;
    secret_key: string;
    session_token?: string;
  } {
    const key = profile ?? "__none__";
    if (awsCredentialsRuntimeCache.has(key)) {
      return awsCredentialsRuntimeCache.get(key) as {
        access_key: string;
        secret_key: string;
        session_token?: string;
      };
    }
  
    if (profile === undefined) {
      const accessKey = process.env.AWS_ACCESS_KEY_ID;
      const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
      if (accessKey && secretKey) {
        const creds = {
          access_key: accessKey,
          secret_key: secretKey,
          session_token: process.env.AWS_SESSION_TOKEN || process.env.AWS_SECURITY_TOKEN,
        };
        awsCredentialsRuntimeCache.set(key, creds);
        return creds;
      }
    }
  
    const profileName = normalizeAwsProfileName(profile || process.env.AWS_PROFILE || "default");
  
    const fileCreds = readAwsCredentialsFile(profileName);
    if (fileCreds) {
      awsCredentialsRuntimeCache.set(key, fileCreds);
      return fileCreds;
    }
  
    const config = readAwsConfigSection(profileName);
    const usesSso =
      "sso_start_url" in config || "sso_session" in config || "sso_account_id" in config;
    const usesProcess = "credential_process" in config;
  
    if (usesSso || usesProcess) {
      try {
        const result = awsCmd(["configure", "export-credentials", "--format", "json"], profile);
        if (result.stdout) {
          const data = JSON.parse(result.stdout) as AnyDict;
          const accessKey = data.AccessKeyId;
          const secretKey = data.SecretAccessKey;
          if (accessKey && secretKey) {
            const creds = {
              access_key: String(accessKey),
              secret_key: String(secretKey),
              session_token: data.SessionToken ? String(data.SessionToken) : undefined,
            };
            awsCredentialsRuntimeCache.set(key, creds);
            return creds;
          }
        }
      } catch (error) {
        if (!(error instanceof CommandError || error instanceof SyntaxError)) {
          throw error;
        }
      }
    }
  
    const data = awsJson(["sts", "get-session-token"], profile);
    const creds = (data.Credentials ?? {}) as AnyDict;
    const accessKey = creds.AccessKeyId;
    const secretKey = creds.SecretAccessKey;
    if (!accessKey || !secretKey) {
      throw new RuntimeError("Unable to resolve AWS credentials for signing");
    }
  
    const resolved = {
      access_key: String(accessKey),
      secret_key: String(secretKey),
      session_token: creds.SessionToken ? String(creds.SessionToken) : undefined,
    };
    awsCredentialsRuntimeCache.set(key, resolved);
    return resolved;
  }
  
  function signRequest(
    method: string,
    url: string,
    payload: Buffer,
    region: string,
    profile: string | undefined,
  ): Record<string, string> {
    const creds = getAwsCredentials(profile);
    const accessKey = creds.access_key;
    const secretKey = creds.secret_key;
    const sessionToken = creds.session_token;
  
    const parsed = new URL(url);
    const host = parsed.host;
    const canonicalUri = parsed.pathname || "/";
  
    const now = new Date();
    const amzDate = formatAmzDate(now);
    const dateStamp = formatAmzDateStamp(now);
  
    const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");
    const canonicalHeaders: string[] = [`host:${host}`, `x-amz-date:${amzDate}`];
    const signedHeaders: string[] = ["host", "x-amz-date"];
  
    if (sessionToken) {
      canonicalHeaders.push(`x-amz-security-token:${sessionToken}`);
      signedHeaders.push("x-amz-security-token");
    }
  
    const canonicalHeadersStr = `${canonicalHeaders.join("\n")}\n`;
    const signedHeadersStr = signedHeaders.join(";");
    const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeadersStr}\n${signedHeadersStr}\n${payloadHash}`;
  
    const algorithm = "AWS4-HMAC-SHA256";
    const credentialScope = `${dateStamp}/${region}/execute-api/aws4_request`;
    const canonicalRequestHash = crypto.createHash("sha256").update(canonicalRequest).digest("hex");
    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHash}`;
  
    const hmac = (key: Buffer | string, msg: string): Buffer =>
      crypto.createHmac("sha256", key).update(msg, "utf8").digest();
  
    const kDate = hmac(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, "execute-api");
    const kSigning = hmac(kService, "aws4_request");
    const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  
    const authorization =
      `${algorithm} Credential=${accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeadersStr}, Signature=${signature}`;
  
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Amz-Date": amzDate,
      Authorization: authorization,
    };
  
    if (sessionToken) {
      headers["X-Amz-Security-Token"] = sessionToken;
    }
  
    return headers;
  }

  return {
    awsCmd,
    awsJson,
    resolveRegion,
    resolveWorkspaceMount,
    resolveSshMount,
    isWsl,
    detectWindowsUserprofile,
    toWslPath,
    getUserId,
    getStackOutputs,
    getOutputValue,
    resolveApiUrlFromOutputs,
    buildDevboxNetworkPayload,
    getApiUrl,
    signRequest,
  };
}
