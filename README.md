# Introduction
This tool uses an [Electron](https://electronjs.org) window to kick off and shadow the [Azure Active Directory](https://azure.microsoft.com) login process for an AWS federation, extract the SAML token on success, use it to authenticate to the [AWS Security Token Service](https://docs.aws.amazon.com/STS/latest/APIReference/Welcome.html), and populate the AWS credentials file with the returned session credentials.

Once successfully logged in and a role is chosen, the tool will minimize to the system tray and wake up with 5 minutes remaining in the session token to prompt for a refresh. Multiple sessions can be active at the same time, and the primary Azure AD credentials remain active until the timeout configured by the administrator, so most session token refreshes are a relatively painless matter of choosing the profile to refresh and the relevant AWS role, rather than re-entering domain credentials and MFA (if configured) each time.

Inspiration for this project was found in https://github.com/dtjohnson/aws-azure-login (and the Azure initialization and SAML token parsing code remain). This project was initiated when an Azure UI change broke the code-driven navigation. The original project added support for Chrome puppeteer UI in parallel to this project adopting a similar approach with Electron, and the original still supports GUI-less logins, so it may be better suited to some users' use cases.

# Getting Started
## Dependencies
* [AWS CLI](http://docs.aws.amazon.com/cli/latest/userguide/installing.html)
* [Node.js](https://nodejs.org/)
* Ensure that you are able to log in to your organization's AWS federation using the web interface.
* Ubuntu 17.10 requires legacy icon support to allow for minimizing to the tray, at least until this [upstream Electron issue](https://github.com/electron/electron/issues/10887) is corrected. In the meantime, the [TopIcons](https://extensions.gnome.org/extension/495/topicons/) extension is known to work for Ubuntu 17.10.

## Configuration
To [configure the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-getting-started.html), run `aws --configure` and leave the AWS Access Key ID and AWS Secret Access Key fields blank.

To work with multiple roles and/or accounts, you can add and configure profiles using this tool, or [configure multiple, named profiles](https://docs.aws.amazon.com/cli/latest/userguide/cli-multiple-profiles.html) with the AWS CLI, by running `aws --configure --profile my_profile`, again leaving the credentials fields blank.

1. On startup, the tool will provide a list of existing AWS profiles. Fully configured profiles will show as 'inactive' under the Expiration column, and unconfigured profiles 'n/a'.
2. Configure your profile with the Azure Tenant ID and App ID URI (see "Getting Your Tenant ID and App ID URI" below).
    * The default Role ARN can be left blank.
    * Session Duration must be less than or equal to the maximum configured for the role in the AWS account. Default is 60 minutes.
3. Save, or Save & Log In.

## Using
1. Open the tool, select a profile to log in to, and authenticate with your Azure AD credentials.
2. On successful login, you will be prompted for a role choice. If desired, save your role choice as the default for future sessions.
3. Click Assume Role.
4. The tool will minimize to the system tray and remain active, counting down until the session timeout.
5. Click on the system tray icon to open the tool, to log in to other profiles or refresh active profiles.
6. With 5 minutes remaining in any active session, the main window will re-open to prompt for an authentication refresh.

## Getting Your Tenant ID and App ID URI

Your Azure AD system admin should be able to provide you with your Tenant ID and App ID URI. If you can't get it from them, you can scrape it from a login page from the myapps.microsoft.com page as described below.

1. Load the [myapps.microsoft.com](https://myapps.microsoft.com) page.
2. Click the chicklet for the login you want.
3. In the window the pops open quickly copy the login.microsoftonline.com URL. (If you miss it just try again. You can also open the developer console with nagivation preservation to capture the URL.)
4. The GUID right after login.microsoftonline.com/ is the tenant ID.
5. Copy the SAMLRequest URL param.
6. Paste it into a URL decoder ([like this one](https://www.samltool.com/url.php)) and decode.
7. Paste the decoded output into the a SAML deflated and encoded XML decoder ([like this one](https://www.samltool.com/decode.php)).
8. In the decoded XML output the value of the Issuer tag is the App ID URI.

# Develop
1. Build and Test
* Check out the source code, e.g. `git clone https://github.com/mr-olson/azure-aws-creds.git`
* First run `npm install` or `npm start` to install NPM packages
* To debug the entire event loop and application using Visual Studio Code, configure Python for your system and start debugging (Debug -> Start or F5).
* To debug just the application UI, you can run `npm run debug`
* To run the application UI, you can run `npm start`
2. Package
* `npm run release` will build OS-specific binary / installable packages in the dist directory. Ubuntu 17.10, Mac and Windows have been confirmed to work. Cross-compiling contributions welcome!

# Contribute
Pull requests are welcome for features or fixes.

# License
MIT
