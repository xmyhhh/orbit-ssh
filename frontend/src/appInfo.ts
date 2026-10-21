import packageInfo from "../package.json";

export const appVersion = packageInfo.version.split(".").slice(0, 2).join(".");
export const projectURL = "https://github.com/xmyhhh/orbit-ssh";
