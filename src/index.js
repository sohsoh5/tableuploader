/// <reference types="@fastly/js-compute" />
import { includeBytes } from "fastly:experimental";

// Include the HTML file to be served
const htmlContent = includeBytes("./src/index.html");

addEventListener("fetch", (event) => {
  console.log("Received fetch event");
  event.respondWith(handleRequest(event));
});

// Function to handle the fetch request
async function handleRequest(event) {
  const { request } = event;
  const url = new URL(request.url);
  console.log(`Handling request for ${url.pathname} with method ${request.method}`);

  if (url.pathname === "/" && request.method === "GET") {
    console.log("Serving HTML page");
    return new Response(htmlContent, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: 200
    });
  } else if (url.pathname === "/process" && request.method === "POST") {
    try {
      console.log("Processing form submission");

      // Extract form data
      const formDataText = await request.text();
      const boundaryMatch = request.headers.get('content-type').match(/boundary=(.*)/);
      if (!boundaryMatch) {
        throw new Error("Boundary not found in content-type header");
      }
      const boundary = boundaryMatch[1];
      const formData = parseMultipartFormData(formDataText, boundary);
      console.log("Parsed form data");

      // Extract API key, files, VCL snippet, and activatingVersion
      const apiKey = formData.apiKey;
      if (!apiKey) {
        throw new Error("API key is missing.");
      }
      console.log("Extracted API key");

      const files = formData.files || [];
      console.log(`Found ${files.length} files`);

      const vclSnippet = formData.vclSnippet || null;
      console.log(`VCL Snippet to delete: ${vclSnippet}`);

      // Set activatingVersion to '1' if checkboxValue is '1'
      const activatingVersion = formData.activatingVersion === '1' ? '1' : '0';
      console.log(`Activate version applicable: ${activatingVersion}`);
      
      let messages = [];
      for (let file of files) {
        const content = file.content;
        const filename = file.name;
        const serviceId = extractServiceId(filename);
        console.log(`Processing file: ${filename} with service ID: ${serviceId}`);

        // Process the file content
        const result = await processFile(apiKey, serviceId, content, vclSnippet, activatingVersion);
        messages.push(result);
      }

      // Return the response with success message
      const successMessage = "Success! Files processed. Add more?";
      console.log("All files processed successfully");
      return new Response(generateHTML(successMessage), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        status: 200
      });

    } catch (error) {
      console.error(`Error processing request: ${error.message}`);
      return new Response(generateHTML(`Error processing request: ${error.message}`), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        status: 500
      });
    }
  }

  console.log("Path not found");
  return new Response("Not Found", { status: 404 });
}

// Function to generate HTML with a message
function generateHTML(message) {
  console.log("Generating HTML content");
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Fastly Dictionary & ACL Batch Uploader Tool</title>
    </head>
    <body>
        <div id="message">
            ${message}
        </div>
    </body>
    </html>
  `;
}


// Function to parse multipart form data
function parseMultipartFormData(body, boundary) {
  console.log("Parsing multipart form data");
  const data = { files: [] };
  const parts = body.split(`--${boundary}`);

  parts.forEach(part => {
    part = part.trim();
    if (!part || part === '--') return;

    const [header, content] = part.split('\r\n\r\n');
    if (!header || !content) return;

    const nameMatch = header.match(/name="([^"]+)"/);
    const filenameMatch = header.match(/filename="([^"]+)"/);
    if (!nameMatch) return;

    const name = nameMatch[1];
    if (filenameMatch) {
      const filename = filenameMatch[1];
      data.files.push({ name: filename, content: content.trim() });
      console.log(`Extracted file: ${filename}`);
    } else {
      data[name] = content.trim();
    }
  });

  return data;
}

async function processFile(apiKey, serviceId, content, vclSnippet, activatingVersion) {
  console.log(`Starting process for service ID: ${serviceId}`);

  // Validate and sanitize the serviceId
  if (!serviceId || typeof serviceId !== 'string' || serviceId.trim() === '') {
    console.error("Invalid service ID:", serviceId);
    throw new Error("Invalid service ID");
  }
  serviceId = serviceId.trim();
  serviceId = serviceId.replace(/[^a-zA-Z0-9_-]/g, ''); // Sanitize to only allow safe characters
  console.log(`Sanitized service ID: ${serviceId}`);

  const headers = {
    'Fastly-Key': apiKey,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Connection': 'close'
  };

  try {
    // Specify the backend for Fastly API calls
    const backend = 'fastly_api_backend';

    // Get the current active version of the service
    const activeVersionUrl = `https://api.fastly.com/service/${serviceId}/version`;
    console.log(`Fetching active version from ${activeVersionUrl}`);
    const activeVersionResponse = await fetch(activeVersionUrl, { 
      method: 'GET', 
      headers,
      backend
    });
    const activeVersions = await activeVersionResponse.json();
    const activeVersion = activeVersions.find(v => v.active).number;
    console.log(`Active version: ${activeVersion}`);

    if (!activeVersion) throw new Error("Active version not found.");

    let newVersion = activeVersion;
    let needsClone = false;

    // Parse the content into dictionaries and ACLs
    const { dictionaries, acls } = parseFileContent(content);
    console.log("Parsed file content into dictionaries and ACLs");

    // Check dictionaries
    for (const name of Object.keys(dictionaries)) {
      const existingDictId = await getDictionaryId(serviceId, activeVersion, name, headers, backend);
      if (!existingDictId) {
        needsClone = true;
        break;
      }
    }

    // Check ACLs
    if (!needsClone) {
      for (const name of Object.keys(acls)) {
        const existingAclId = await getAclId(serviceId, activeVersion, name, headers, backend);
        if (!existingAclId) {
          needsClone = true;
          break;
        }
      }
    }

    // Force clone if a VCL snippet needs to be deleted
    if (vclSnippet) {
      needsClone = true;
    }

    if (needsClone) {
      // Clone the active version
      newVersion = await cloneActiveVersion(serviceId, activeVersion, headers, backend);
      console.log(`Cloned to new version: ${newVersion}`);
      if (!newVersion) throw new Error("Failed to clone the active version.");

      // Create dictionaries and ACLs in the new version
      for (const [name, entries] of Object.entries(dictionaries)) {
        const dictionaryId = await createDictionary(serviceId, newVersion, name, headers, backend);
        console.log(`Created dictionary: ${name} with ID: ${dictionaryId}`);
        if (dictionaryId) {
          // Batch upload dictionary entries
          await populateDictionary(serviceId, dictionaryId, entries, headers, backend);
          console.log(`Populated dictionary: ${name}`);
        }
      }

      for (const [name, entries] of Object.entries(acls)) {
        const aclId = await createAcl(serviceId, newVersion, name, headers, backend);
        console.log(`Created ACL: ${name} with ID: ${aclId}`);
        if (aclId) {
          // Batch upload ACL entries
          await populateAcl(serviceId, aclId, entries, headers, backend);
          console.log(`Populated ACL: ${name}`);
        }
      }

      // Optionally delete an existing VCL snippet
      if (vclSnippet) {
        await deleteVclSnippet(serviceId, newVersion, vclSnippet, headers, backend);
      }

      // Activate the new version
      if (activatingVersion === '1'){
        await activateVersion(serviceId, newVersion, headers, backend);
        console.log(`Activated new version: ${newVersion}`);
      }
    }
    // Batch update dictionaries in the existing version
    for (const [name, entries] of Object.entries(dictionaries)) {
      const dictionaryId = await getDictionaryId(serviceId, activeVersion, name, headers, backend);
      if (dictionaryId) {
        await populateDictionary(serviceId, dictionaryId, entries, headers, backend);
        console.log(`Populated dictionary: ${name}`);
      } else {
        console.warn(`Dictionary ${name} does not exist, skipping update.`);
      }
    }

    // Batch update ACLs in the existing version
    for (const [name, entries] of Object.entries(acls)) {
      const aclId = await getAclId(serviceId, activeVersion, name, headers, backend);
      if (aclId) {
        await populateAcl(serviceId, aclId, entries, headers, backend);
        console.log(`Populated ACL: ${name}`);
      } else {
        console.warn(`ACL ${name} does not exist, skipping update.`);
      }
    }
    

    return `Version ${newVersion} processed successfully.`;

  } catch (error) {
    console.error(`Error processing file: ${error.message}`);
    return `Error: ${error.message}`;
  }
}




// Utility function to extract service ID from the filename
function extractServiceId(filename) {
  console.log(`Extracting service ID from filename: ${filename}`);
  return filename.split('_')[0];
}

async function getDictionaryId(serviceId, version, name, headers, backend) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${version}/dictionary`;
  console.log(`Fetching dictionaries from ${url}`);
  const response = await fetch(url, { method: 'GET', headers, backend });

  if (response.ok) {
    const dictionaries = await response.json();
    const dictionary = dictionaries.find(dict => dict.name === name);
    return dictionary ? dictionary.id : null;
  } else {
    console.error("Failed to fetch dictionaries:", response.statusText);
    return null;
  }
}

async function getAclId(serviceId, version, name, headers, backend) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${version}/acl`;
  console.log(`Fetching ACLs from ${url}`);
  const response = await fetch(url, { method: 'GET', headers, backend });

  if (response.ok) {
    const acls = await response.json();
    const acl = acls.find(acl => acl.name === name);
    return acl ? acl.id : null;
  } else {
    console.error("Failed to fetch ACLs:", response.statusText);
    return null;
  }
}

async function cloneActiveVersion(serviceId, activeVersion, headers, backend) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${activeVersion}/clone`;
  console.log(`Cloning version with URL: ${url}`);
  const response = await fetch(url, {
    method: 'PUT',
    headers: headers,
    backend
  });

  if (response.ok) {
    const data = await response.json();
    console.log(`Cloned version number: ${data.number}`);
    return data.number; // New version number
  } else {
    console.error("Failed to clone version:", response.statusText);
    return null;
  }
}

async function createDictionary(serviceId, version, name, headers, backend) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${version}/dictionary`;
  console.log(`Creating dictionary with URL: ${url}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ name: name }),
    backend
  });

  if (response.ok) {
    const data = await response.json();
    console.log(`Created dictionary ID: ${data.id}`);
    return data.id; // Return the dictionary ID
  } else {
    console.error("Failed to create dictionary:", response.statusText);
    return null;
  }
}

async function populateDictionary(serviceId, dictionaryId, entries, headers, backend) {
  // Prepare batch update payload
  const batchItems = [];
  for (const [key, value] of Object.entries(entries)) {
    batchItems.push({
      op: "create", // or "update", "upsert", "delete" based on your logic
      item_key: key,
      item_value: value
    });
  }

  const url = `https://api.fastly.com/service/${serviceId}/dictionary/${dictionaryId}/items`;
  console.log(`Batch updating dictionary ${dictionaryId} with items: ${JSON.stringify(batchItems)}`);

  const response = await fetch(url, {
    method: 'PATCH',
    headers: headers,
    body: JSON.stringify({ items: batchItems }),
    backend
  });

  if (response.ok) {
    console.log(`Batch updated dictionary ${dictionaryId}`);
  } else {
    console.error(`Failed to batch update dictionary ${dictionaryId}:`, response.statusText);
  }
}

async function createAcl(serviceId, version, name, headers, backend) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${version}/acl`;
  console.log(`Creating ACL with URL: ${url}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ name: name }),
    backend
  });

  if (response.ok) {
    const data = await response.json();
    console.log(`Created ACL ID: ${data.id}`);
    return data.id; // Return the ACL ID
  } else {
    console.error("Failed to create ACL:", response.statusText);
    return null;
  }
}

async function populateAcl(serviceId, aclId, entries, headers, backend) {
  // Prepare batch update payload
  const batchEntries = [];
  for (const entry of entries) {
    batchEntries.push({
      op: "create", // or "update", "delete" based on your logic
      ip: entry.ip,
      subnet: entry.subnet
    });
  }

  const url = `https://api.fastly.com/service/${serviceId}/acl/${aclId}/entries`;
  console.log(`Batch updating ACL ${aclId} with entries: ${JSON.stringify(batchEntries)}`);
  
  const response = await fetch(url, {
    method: 'PATCH',
    headers: headers,
    body: JSON.stringify({ entries: batchEntries }),
    backend
  });

  if (response.ok) {
    console.log(`Batch updated ACL ${aclId}`);
  } else {
    console.error(`Failed to batch update ACL ${aclId}:`, response.statusText);
  }
}
// Function to delete a VCL snippet
async function deleteVclSnippet(serviceId, version, snippetName, headers, backend) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${version}/snippet/${snippetName}`;
  console.log(`Deleting snippet: ${snippetName}`);
  const response = await fetch(url, {
    method: 'DELETE',
    headers: headers,
    backend
  });

  if (response.ok) {
    console.log(`Deleted snippet ${snippetName} from version ${version}`);
  } else {
    console.error(`Failed to delete snippet ${snippetName}:`, response.statusText);
  }
}

async function activateVersion(serviceId, version, headers, backend) {
  const url = `https://api.fastly.com/service/${serviceId}/version/${version}/activate`;
  console.log(`Activating version with URL: ${url}`);
  const response = await fetch(url, {
    method: 'PUT',
    headers: headers,
    backend
  });

  if (response.ok) {
    console.log(`Activated version ${version} for service ID ${serviceId}`);
  } else {
    console.error(`Failed to activate version ${version}:`, response.statusText);
  }
}

// Function to parse the file content into dictionaries and ACLs
function parseFileContent(content) {
  console.log("Parsing file content");
  const dictionaries = {};
  const acls = {};
  let currentTable = null;
  let currentAcl = null;

  const lines = content.split('\n');
  for (let line of lines) {
    line = line.trim();

    if (line === '' || line === '}') continue;

    if (line.startsWith('table ')) {
      const tableName = line.split(' ')[1].replace('{', '').trim();
      currentTable = tableName;
      dictionaries[tableName] = {};
      currentAcl = null;
      console.log(`Detected table: ${tableName}`);
    } else if (line.startsWith('acl ')) {
      const aclName = line.split(' ')[1].replace('{', '').trim();
      currentAcl = aclName;
      acls[aclName] = [];
      currentTable = null;
      console.log(`Detected ACL: ${aclName}`);
    } else if (currentTable && line.includes(': ')) {
      const [key, value] = line.split(': ').map(part => part.trim().replace(/"/g, '').replace(',', ''));
      dictionaries[currentTable][key] = value;
      console.log(`Parsed entry for table ${currentTable}: ${key} = ${value}`);
    } else if (currentAcl) {
      let [ip, subnet] = line.replace(/[";]/g, '').split('/');
      if (subnet === undefined) {
        subnet = 32; // Default to /32 if subnet is not specified
      } else {
        subnet = parseInt(subnet.trim(), 10);
      }
      acls[currentAcl].push({ ip: ip.trim(), subnet });
      console.log(`Parsed entry for ACL ${currentAcl}: IP ${ip.trim()} / ${subnet}`);
    }
  }

  console.log("Parsed dictionaries and ACLs");
  return { dictionaries, acls };
}
