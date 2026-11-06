import { Request, Response } from "express";
import fs from "fs-extra";
import path from "path";
import { isInside, serverRoot } from "../utils/security.js";


/* Plugin and mod installation. */
export const installPlugin = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { source, pluginId, pluginName } = req.body;
  
  // Allow direct downloadUrl fallback for backward compatibility
  if (req.body.downloadUrl) {
     try {
        const serverDir = serverRoot(id);
        const pluginsDir = path.join(serverDir, "plugins");
        await fs.ensureDir(pluginsDir);
        const safeFilename = path.basename(String(req.body.filename || ""));
        if (!safeFilename || safeFilename.startsWith(".") || !/\.(jar|zip)$/i.test(safeFilename)) {
          return res.status(400).json({ error: "Invalid filename (must be a .jar or .zip file name)" });
        }
        const filePath = path.join(pluginsDir, safeFilename);
        if (!isInside(pluginsDir, filePath)) return res.status(403).json({ error: "Invalid path" });
        {
          const { assertPublicHttpUrl } = await import("../utils/security.js");
          await assertPublicHttpUrl(String(req.body.downloadUrl));
          const axios = (await import("axios")).default;
          const response = await axios({ url: String(req.body.downloadUrl), method: 'GET', responseType: 'stream', maxRedirects: 0, timeout: 60000 });
          const writer = fs.createWriteStream(filePath);
          response.data.pipe(writer);
          await new Promise<void>((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        }
        return res.json({ success: true, message: "Plugin installed successfully" });
     } catch(e) {
        return res.status(500).json({ error: "Failed to install plugin" });
     }
  }

  if (!source || !pluginId || !pluginName) {
    return res.status(400).json({ error: "Missing source, pluginId, or pluginName" });
  }

  try {
    const serverDir = serverRoot(id);
    const pluginsDir = path.join(serverDir, "plugins");
    await fs.ensureDir(pluginsDir);
    
    let downloadUrl = null;
    let filename = `${pluginName.replace(/[^a-zA-Z0-9]/g, '_')}.jar`;
    const axios = (await import("axios")).default;

    if (source === 'modrinth') {
      const verRes = await axios.get(`https://api.modrinth.com/v2/project/${pluginId}/version`);
      if (verRes.data && verRes.data.length > 0) {
        const file = verRes.data[0].files.find((f: any) => f.primary) || verRes.data[0].files[0];
        if (file) {
           downloadUrl = file.url;
           filename = file.filename || filename;
        }
      }
    } else if (source === 'spigot') {
       const apiRes = await axios.get(`https://api.spiget.org/v2/resources/${pluginId}`);
       if (apiRes.data && apiRes.data.file) {
         if (apiRes.data.file.type === 'external' && apiRes.data.file.externalUrl) {
           const extUrl = apiRes.data.file.externalUrl;
           if (extUrl.includes('github.com') && extUrl.includes('/releases/')) {
             // Try to extract github repo to get the jar
             const match = extUrl.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/tag\/([^/]+)/);
             if (match) {
               const owner = match[1];
               const repo = match[2];
               const tag = match[3];
               const ghRes = await axios.get(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`);
               if (ghRes.data && ghRes.data.assets) {
                 const jarAsset = ghRes.data.assets.find((a: any) => a.name.endsWith('.jar'));
                 if (jarAsset) {
                   downloadUrl = jarAsset.browser_download_url;
                   filename = jarAsset.name;
                 }
               }
             } else {
               const matchLatest = extUrl.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/latest/);
               if (matchLatest) {
                 const owner = matchLatest[1];
                 const repo = matchLatest[2];
                 const ghRes = await axios.get(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
                 if (ghRes.data && ghRes.data.assets) {
                   const jarAsset = ghRes.data.assets.find((a: any) => a.name.endsWith('.jar'));
                   if (jarAsset) {
                     downloadUrl = jarAsset.browser_download_url;
                     filename = jarAsset.name;
                   }
                 }
               }
             }
           }
           
           if (!downloadUrl) {
             return res.status(400).json({ error: "This plugin must be downloaded externally from: " + extUrl });
           }
         } else {
           downloadUrl = `https://api.spiget.org/v2/resources/${pluginId}/download`;
         }
       } else {
         downloadUrl = `https://api.spiget.org/v2/resources/${pluginId}/download`;
       }
    } else if (source === 'hangar') {
       const [owner, slug] = pluginId.split('/');
       const verRes = await axios.get(`https://hangar.papermc.io/api/v1/projects/${owner}/${slug}/versions`);
       if (verRes.data && verRes.data.result && verRes.data.result.length > 0) {
         const version = verRes.data.result[0];
         const download = version.downloads.PAPER || Object.values(version.downloads)[0];
         if (download && (download as any).downloadUrl) {
            downloadUrl = (download as any).downloadUrl;
            if ((download as any).fileInfo && (download as any).fileInfo.name) {
                filename = (download as any).fileInfo.name;
            }
         } else if (download && (download as any).externalUrl) {
            return res.status(400).json({ error: "This plugin must be downloaded externally from: " + (download as any).externalUrl });
         }
       }
    }

    if (!downloadUrl) {
      return res.status(404).json({ error: "Could not find a valid download URL for this plugin." });
    }

    const filePath = path.join(pluginsDir, path.basename(filename));
    const response = await axios({
      url: downloadUrl,
      method: 'GET',
      responseType: 'stream',
      headers: {
         'User-Agent': 'React-Minecraft-Panel/1.0'
      }
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    res.json({ success: true, message: "Plugin installed successfully" });
  } catch (error: any) {
    console.error("Plugin installation failed:", error.message);
    res.status(500).json({ error: "Plugin installation failed: " + error.message });
  }
};

export const installMod = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { pluginId, pluginName } = req.body; 

  if (!pluginId || !pluginName) {
    return res.status(400).json({ error: "Missing pluginId or pluginName" });
  }

  try {
    const serverDir = serverRoot(id);
    const modsDir = path.join(serverDir, "mods");
    await fs.ensureDir(modsDir);
    
    let downloadUrl = null;
    let filename = `${pluginName.replace(/[^a-zA-Z0-9]/g, '_')}.jar`;
    const axios = (await import("axios")).default;

    const verRes = await axios.get(`https://api.modrinth.com/v2/project/${pluginId}/version`);
    if (verRes.data && verRes.data.length > 0) {
      const file = verRes.data[0].files.find((f: any) => f.primary) || verRes.data[0].files[0];
      if (file) {
          downloadUrl = file.url;
          filename = file.filename || filename;
      }
    }

    if (!downloadUrl) {
      return res.status(404).json({ error: "Could not find a valid download URL for this mod." });
    }

    const filePath = path.join(modsDir, path.basename(filename));
    const response = await axios({
      url: downloadUrl,
      method: 'GET',
      responseType: 'stream',
      headers: {
         'User-Agent': 'React-Minecraft-Panel/1.0'
      }
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    res.json({ success: true, message: "Mod installed successfully" });
  } catch (error: any) {
    console.error("Mod installation failed:", error.message);
    res.status(500).json({ error: "Mod installation failed: " + error.message });
  }
};

