# Fastly Dictionary & ACL API Automation Tool

This project is a compute@edge tool for dynamically uploading dictionaries and acls via Fastly's API. It also allows the ability to optionally delete VCL snippets, and control version activation via a checkbox.

## Features

- Upload multiple txt files for dictionary and ACL updates.
- Takes service IDs from file name. ex: <service_id>_tables.txt.
- Uses your provided api tokens
- Uploads a dictionary and acl per entry in the file, formatted as if it were a vcl snippet's entry.
- Smart version alterations: only updates edge dictionaries without a version change if there are no additional new dictionaries or acls being uploaded (and the snippets field is empty).
- Optionally delete VCL snippets from Fastly configurations - useful if you have a hardcoded snippet for the same named tables and acls, as it'll cause a conflict to have more than one unique named tables/acls.
- Activate new versions based on user input - if you're uploading a dictionary or acl, or if you enter a value into the prompt box, it will create a new version. It will only activate if the check box is checked.
- Uses patch api calls, leading to incredibly quick uploads.
- Able to run locally to circumvent any limitations, such as the ~60 requests the service's backend can make. It's recommended to only run up to a total of 60 acl/dictionary updates total across all of your files at a time.

## Project Structure

- `index.html`: The main HTML file providing the form for file uploads and VCL snippet deletion.
- `index.js`: javascript server script handling data from main HTML and uses them for Fastly API interactions.
- Testing folder has example tables to use

## Prerequisites

- Access to the page (it's public at this moment: https://only-dynamic-quagga.edgecompute.app/).
- Fastly API credentials.

## Instructions

- Procure a properly scoped token, add it to the api key field.
- Select any number of files via the file selection button. The file should have the service id in the name, followed by _tables.txt. Ex. 23123151_tables.txt
- Enter a single table to delete
- Check box for version activation if one is created and it is desired.
- Click upload files and wait a few seconds for it to complete.

## Tips and Caveats

- The files should look as if you added tables to a VCL snippet. If there is a snippet already existant, grab the entire content desired and drop it into the file
- These are patch updates, meaning the uploads are fast. However, a patch updates via the entirety of the entry, so if one field is already on the destination table, it will not upload anything. You can get around this by just removing the duplicate entries in that file's table.
- If there is anything on the vcl snippet field, a new version will be created for all services involved in that upload batch. Otherwise, version creation depends on if there is a new dictionary or acl, and are individual to each service.
- You can reuse the same page, just repeatedly click the upload button when you have to appropriate files selected. This can make sending a batch of updates very quick to different services that need a version activation vs ones that do not need the activation, one after the other.


## Local compiling

If downloading to run locally, you will need to install and create a project on compute@edge: https://www.fastly.com/documentation/guides/compute/. After creation, just place the index.js and index.html into your /src directory. You will also need to add the following into the fastly.toml file:

[local_server]
  [local_server.backends]
    [local_server.backends.fastly_api_backend]
      url = "https://api.fastly.com/"
      override_host = "api.fastly.com"

  Perform the fastly compute init command to start the project, then fastly compute serve to have it run locally. Follow the prompt in the command line to access your service and perform nearly limitless uploads. 


Please feel free to slack me @soh on the company slack channel if you have any concerns or want a word regarding the tool.
