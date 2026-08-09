# AAUP Major Advisor

The **AAUP Major Advisor** is a bilingual English–Arabic application that helps prospective students explore bachelor’s programs at Arab American University.

Students can use the Advisor through an AI-assisted conversation or directly through its visual form. Recommendations are based on certificate system, branch or classification, academic average, campus preference, interests, career goals, and tuition preference.

> Results provide preliminary academic guidance. Final admission eligibility must be confirmed by the AAUP Deanship of Admission and Registration.

## Features

* English and Arabic support
* Right-to-left Arabic interface
* AI-assisted and direct form use
* Preliminary eligibility checking
* Jenin and Ramallah campus filtering
* Tawjihi and Bagrut support
* Foreign-certificate review guidance
* Alternative admission-route handling
* Interest and career-goal matching
* Tuition and budget comparison
* Official AAUP source references
* Admissions-data expiration protection
* Startup data validation
* Automated tests and GitHub Actions
* Rate limiting and health monitoring
* No database or GPU required

## MCP Tools

### `show_major_match_form`

Opens the bilingual visual form used to collect the student’s academic information and preferences.

### `create_major_match_report`

Generates an English or Arabic report containing:

* Preliminarily eligible programs
* Programs requiring official review
* Programs that do not meet a published requirement
* Campus and college information
* Published admission requirements
* Tuition information
* Additional program conditions
* Interest and career-fit explanations

Both tools are read-only. They do not submit applications, reserve seats, modify university records, or make official admission decisions.

## Project Structure

```text
AAUP-Major-Advisor/
├── .github/
│   └── workflows/
│       └── ci.yml
├── data/
│   ├── admissionSystems.json
│   └── majors.json
├── src/
│   ├── ui/
│   │   └── majorMatchForm.html
│   ├── aaupServer.js
│   ├── dataValidation.js
│   ├── majorMatchForm.js
│   ├── majorMatchLanguage.js
│   ├── majorMatchTools.js
│   ├── report.js
│   ├── utils.js
│   └── version.js
├── test/
│   └── advisor.test.js
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── server.js
└── README.md
```

## Technology

* Node.js 22
* Express
* Model Context Protocol
* `@modelcontextprotocol/sdk`
* `@modelcontextprotocol/ext-apps`
* Zod
* `express-rate-limit`
* HTML, CSS, and vanilla JavaScript
* Local JSON admissions data
* Node test runner
* GitHub Actions

## Local Setup

Clone the repository:

```bash
git clone https://github.com/bhbakri/AAUP-Major-Advisor.git
cd AAUP-Major-Advisor
```

Install dependencies:

```bash
npm install
```

Run the tests:

```bash
npm test
```

Start the server:

```bash
npm start
```

The application runs on port `8787` by default.

```text
Status:    http://localhost:8787/
MCP:       http://localhost:8787/mcp
Health:    http://localhost:8787/healthz
Readiness: http://localhost:8787/readyz
```

## Environment Variables

Production variables are documented in `.env.example`.

```env
NODE_ENV=production
PORT=8787
OPENAI_APPS_CHALLENGE=
TRUST_PROXY=
REQUEST_TIMEOUT_MS=120000
HEADERS_TIMEOUT_MS=65000
KEEP_ALIVE_TIMEOUT_MS=60000
```

`TRUST_PROXY` should match the production reverse-proxy configuration. It should remain blank during local development.

## Production Deployment

Install locked production dependencies:

```bash
npm ci --omit=dev
```

Start the application:

```bash
npm start
```

The public MCP endpoint is:

```text
https://advisor.aaup.edu/mcp
```

The production environment should provide HTTPS through a reverse proxy and monitor:

```text
/healthz
/readyz
```

## Server Requirements

### Minimum

Suitable for development, testing, and limited production traffic.

```text
Operating system: Linux
Node.js: 22
CPU: 1 vCPU
RAM: 1 GB
Storage: 2 GB
GPU: Not required
Database: Not required
HTTPS: Required
```

### Suggested

Recommended for the public AAUP deployment.

```text
Operating system: Linux
Node.js: 22
CPU: 2 vCPUs
RAM: 2 GB
Storage: 5 GB
GPU: Not required
Database: Not required
HTTPS: Required
Reverse proxy: Recommended
Process manager: Recommended
Monitoring: Recommended
```

Actual capacity depends on traffic patterns, rate-limit configuration, logging volume, and other services running on the same server.

## Admissions Data

Program and certificate-system information is stored in:

```text
data/majors.json
data/admissionSystems.json
```

The data includes:

* Program names in English and Arabic
* Campuses and colleges
* Eligible certificate branches
* Minimum averages
* Alternative admission routes
* Tuition information
* Additional admission conditions
* Academic-year dates
* Verification dates
* Official AAUP sources

After updating the data, run:

```bash
npm test
npm start
```

The application validates the admissions files before accepting traffic. Invalid or inconsistent data prevents the server from starting.

## Testing and CI

Run all tests:

```bash
npm test
```

Run coverage:

```bash
npm run test:coverage
```

The tests cover data validation, Arabic and English input handling, certificate detection, eligibility reports, recommendation ordering, foreign certificates, invalid averages, and expired admission cycles.

GitHub Actions automatically runs syntax checks and tests on pushes and pull requests to `main`.

## Privacy and Security

The application does not require student accounts and does not intentionally store:

* Passwords
* Student IDs
* Generated reports
* Uploaded documents
* Payment information
* Chat histories
* Official academic records

The server includes rate limiting, restricted MCP methods, request timeouts, startup validation, health checks, readiness checks, and graceful shutdown.

Students should not submit passwords, identification numbers, payment details, medical records, or other unnecessary sensitive information.

## Ownership

The AAUP Major Advisor is operated and published by Arab American University.

The repository and its contents are unlicensed unless AAUP provides a separate license. Public visibility does not grant permission to copy, redistribute, commercially reuse, or misrepresent AAUP code, data, branding, or institutional content.
