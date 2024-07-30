// Import necessary Fastly Compute@Edge modules
import { ConfigStore, env, logger, fetch } from "fastly:experimental";

// Load configuration from the environment or Config Store
const FASTLY_API_KEY = env('B77Xf96w1uss8IQ04K9pKk9RKri12YQd'); // Ensure this is set in the environment
const FOLDER_PATH = env('/Users/soh/Documents/workstuff/tableuploader/testing/'); // This should point to the configuration

const headers = {
  'Fastly-Key': FASTLY_API_KEY,
  'Accept': 'application/json',
  'Content-Type': 'application/json'
};

const SNIPPET_NAME = "Tables";

// Setup logging (Fastly's logger works differently than typical Node.js logging)
function logInfo(message) {
  logger.log(`INFO: ${message}`);
}

function logError(message) {
  logger.log(`ERROR: ${message}`);
}

async function getActiveVersion(serviceId) {
  const url = `https://api.fastly.com/service/${serviceId}/version`;
  try {
    const response = await fetch(url, { headers });
    if (response.ok) {
      const versions = await response.json();
      const activeVersion = versions.find(v => v.active)?.number;
      if (activeVersion) logInfo(`Found active version ${activeVersion} for service ID ${serviceId}`);
      return activeVersion;
    } else {
      throw new Error(`Failed to retrieve versions: ${response.statusText}`);
    }
  } catch (error) {
    logError(`Error getting active version: ${error}`);
    return null;
  }
}

async function cloneActiveVersion(serviceId, activeVersion) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${activeVersion}/clone`;
  try {
    const response = await fetch(url, { method: 'PUT', headers });
    if (response.ok) {
      const versionData = await response.json();
      logInfo(`Cloned new version ${versionData.number} from active version ${activeVersion} for service ID ${serviceId}`);
      return versionData.number;
    } else {
      throw new Error(`Failed to clone version: ${response.statusText}`);
    }
  } catch (error) {
    logError(`Error cloning version: ${error}`);
    return null;
  }
}

async function createDictionary(serviceId, version, name) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${version}/dictionary`;
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name }) });
    if (response.ok) {
      const dictionaryData = await response.json();
      logInfo(`Created dictionary ${name} with ID ${dictionaryData.id} for version ${version}`);
      return dictionaryData.id;
    } else {
      throw new Error(`Failed to create dictionary: ${response.statusText}`);
    }
  } catch (error) {
    logError(`Error creating dictionary: ${error}`);
    return null;
  }
}

async function createAcl(serviceId, version, name) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${version}/acl`;
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name }) });
    if (response.ok) {
      const aclData = await response.json();
      logInfo(`Created ACL ${name} with ID ${aclData.id} for version ${version}`);
      return aclData.id;
    } else {
      throw new Error(`Failed to create ACL: ${response.statusText}`);
    }
  } catch (error) {
    logError(`Error creating ACL: ${error}`);
    return null;
  }
}

async function populateDictionary(serviceId, dictionaryId, entries) {
  for (const [key, value] of Object.entries(entries)) {
    try {
      await fetch(`https://api.fastly.com/service/${serviceId}/dictionary/${dictionaryId}/item`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ item_key: key, item_value: value })
      });
    } catch (error) {
      logError(`Failed to add item ${key}: ${value} to dictionary ${dictionaryId}: ${error}`);
    }
  }
}

function isValidIp(ip) {
  const ipv4Pattern = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Pattern = /^([0-9a-fA-F]{1,4}:){7}([0-9a-fA-F]{1,4}|:)$/;
  return ipv4Pattern.test(ip) || ipv6Pattern.test(ip);
}

function cleanIp(ip) {
  ip = ip.split("\"")[0].trim();
  return isValidIp(ip) ? ip : null;
}

async function populateAcl(serviceId, aclId, entries) {
  for (const entry of entries) {
    const ip = cleanIp(entry.ip);
    if (ip) {
      try {
        await fetch(`https://api.fastly.com/service/${serviceId}/acl/${aclId}/entry`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ip, subnet: entry.subnet || 32, negated: entry.negated || false, comment: entry.comment || '' })
        });
      } catch (error) {
        logError(`Failed to add entry ${entry} to ACL ${aclId}: ${error}`);
      }
    } else {
      logError(`Invalid IP address: ${entry.ip}`);
    }
  }
}

async function deleteVclSnippet(serviceId, version, snippetName) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${version}/snippet/${snippetName}`;
  try {
    await fetch(url, { method: 'DELETE', headers });
    logInfo(`Successfully deleted VCL snippet ${snippetName} for service ID ${serviceId}, version ${version}`);
  } catch (error) {
    logError(`Failed to delete VCL snippet ${snippetName} for service ID ${serviceId}: ${error}`);
  }
}

async function activateVersion(serviceId, version) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${version}/activate`;
  try {
    await fetch(url, { method: 'PUT', headers });
    logInfo(`Activated version ${version} for service ID ${serviceId}`);
  } catch (error) {
    logError(`Failed to activate version ${version} for service ID ${serviceId}: ${error}`);
  }
}

async function processFiles() {
  try {
    const files = await fetch(`https://my-files-service/${FOLDER_PATH}`, { method: 'GET' }); // Placeholder for fetching files
    for (const filename of files) {
      if (filename.endsWith('_tables.txt')) {
        const serviceId = filename.split('_')[0];
        const fileContent = await fetch(`https://my-files-service/${FOLDER_PATH}/${filename}`, { method: 'GET' }); // Placeholder for file content
        const lines = fileContent.split('\n');
        const activeVersion = await getActiveVersion(serviceId);
        if (!activeVersion) continue;
        const version = await cloneActiveVersion(serviceId, activeVersion);
        if (!version) continue;

        let currentDictOrAclName = null;
        let entries = {};
        let aclEntries = [];
        let isAcl = false;

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith('table')) {
            if (isAcl && currentDictOrAclName && aclEntries.length) {
              const aclId = await createAcl(serviceId, version, currentDictOrAclName);
              if (aclId) await populateAcl(serviceId, aclId, aclEntries);
            } else if (currentDictOrAclName && Object.keys(entries).length) {
              const dictionaryId = await createDictionary(serviceId, version, currentDictOrAclName);
              if (dictionaryId) await populateDictionary(serviceId, dictionaryId, entries);
            }
            currentDictOrAclName = trimmedLine.split(' ')[1].replace("{", "");
            entries = {};
            isAcl = false;
          } else if (trimmedLine.startsWith('acl')) {
            if (isAcl && currentDictOrAclName && aclEntries.length) {
              const aclId = await createAcl(serviceId, version, currentDictOrAclName);
              if (aclId) await populateAcl(serviceId, aclId, aclEntries);
            } else if (currentDictOrAclName && Object.keys(entries).length) {
              const dictionaryId = await createDictionary(serviceId, version, currentDictOrAclName);
              if (dictionaryId) await populateDictionary(serviceId, dictionaryId, entries);
            }
            currentDictOrAclName = trimmedLine.split(' ')[1].replace("{", "");
            aclEntries = [];
            isAcl = true;
          } else if (trimmedLine.includes(':') && !isAcl) {
            const [key, value] = trimmedLine.split(':');
            entries[key.trim().replace(/["';]/g, '')] = value.trim().replace(/["';]/g, '');
          } else if (trimmedLine.startsWith('"') && isAcl) {
            const ipEntry = trimmedLine.slice(1, -1).replace(/["';]/g, '');
            if (ipEntry.includes('/')) {
              const [ip, subnet] = ipEntry.split('/');
              aclEntries.push({ ip: ip.trim(), subnet: parseInt(subnet.trim(), 10) });
            } else {
              aclEntries.push({ ip: ipEntry.trim(), subnet: 32 });
            }
          }
        }

        if (currentDictOrAclName) {
          if (isAcl && aclEntries.length) {
            const aclId = await createAcl(serviceId, version, currentDictOrAclName);
            if (aclId) await populateAcl(serviceId, aclId, aclEntries);
          } else if (Object.keys(entries).length) {
            const dictionaryId = await createDictionary(serviceId, version, currentDictOrAclName);
            if (dictionaryId) await populateDictionary(serviceId, dictionaryId, entries);
          }
        }

        await deleteVclSnippet(serviceId, version, SNIPPET_NAME);
        await activateVersion(serviceId, version);
      }
    }
  } catch (error) {
    logError(`Error processing files: ${error}`);
  }
}

processFiles();
