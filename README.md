# Ascend - Personal Portfolio Manager  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A comprehensive, self-hosted portfolio management application designed to track your investments across multiple accounts and currencies.

<p align="center">
  <img src="public/dashboard-light.png" width="45%" alt="Light Mode Dashboard" />
  &nbsp; &nbsp;
  <img src="public/dashboard-dark.png" width="45%" alt="Dark Mode Dashboard" />
</p>

## Features

-   **Multi-Currency Support**: Track investments in their native currency and view your portfolio value in your preferred base currency (e.g., USD, CAD, INR).
-   **Advanced FIRE Analysis**:
    -   **"Solve for X" Simulations**: Calculate the safe withdrawal rate for a specific duration or find out how long a specific rate will last.
    -   **Inflation Adjustment**: Projections account for inflation to ensure real purchasing power is maintained.
    -   **Lifestyle Analysis**: Determine the minimum monthly income required to maintain your current standard of living in retirement.
    -   **Detailed Projections**: Year-by-year breakdown of principal, gains, withdrawals, and balances.
-   **Deep Allocation Analysis**:
    -   **Investment Type Breakdown**: Aggregate view across all asset classes with accurate currency conversion.
    -   **Dividend Analysis**: Automatic yield calculation with fallback deduction for missing data.
    -   **Realized Gains**: Tracking for sold assets and historical performance.
-   **Performance Tracking**:
    -   **XIRR Calculation**: Accurate return on investment considering cash flows.
    -   **Portfolio Evolution**: Visualize Portfolio growth vs. average contributions over time. Visualize dividend history over time.
-   **Portfolio Intelligence (AI)**:
    -   **Natural Language Analysis**: Chat with your portfolio using advanced LLMs (Google Gemini, OpenAI, Claude).
    -   **Deep Insights**: Get personalized answers about asset allocation, risk exposure, and diversification.
    -   **Context-Aware**: The AI understands your current holdings, currency exposure, and sector breakdowns for accurate advice.
-   **Privacy Focused**: Self-hosted solution ensures you own your financial data. AI keys are stored locally.
-   **Dark Mode**: Sleek, eye-friendly interface.

## Installation

### Option 1: Docker (Recommended - Pre-built Image)

The fastest way to get started using the official pre-built image (supports `amd64` and `arm64`).

**Prerequisites:**
-   [Docker](https://docs.docker.com/get-docker/)
-   [Docker Compose](https://docs.docker.com/compose/install/)

**Steps:**

1.  **Create a directory** for the project and enter it:
    ```bash
    mkdir ascend && cd ascend
    ```

2.  **Configure Environment:**
    Create a `.env` file with the following content (or copy from `env.example` if you have the source):
    ```env
    # Database
    POSTGRES_USER=postgres
    POSTGRES_PASSWORD=postgres
    POSTGRES_DB=portfolio_db

    # Next Auth
    NEXTAUTH_URL="http://localhost:3000"
    NEXTAUTH_SECRET="your_secure_random_secret_here" # Generate with: openssl rand -base64 32
    AUTH_TRUST_HOST=true

    # Seeding
    ADMIN_PASSWORD="your_secure_password_here"
    ```

3.  **Create `docker-compose.yml`**:
    Create a file named `docker-compose.yml` with the following content:
    ```yaml
    services:
      app:
        image: rajatpatel7/ascend:latest
        container_name: ascend
        restart: always
        ports:
          - "3000:3000"
        environment:
          - DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
          - NEXTAUTH_URL=${NEXTAUTH_URL}
          - NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
          - AUTH_TRUST_HOST=true
          - ADMIN_PASSWORD=${ADMIN_PASSWORD}
        depends_on:
          - db
        networks:
          - portfolio-network

      db:
        image: postgres:15-alpine
        container_name: portfolio-db
        restart: always
        environment:
          - POSTGRES_USER=${POSTGRES_USER}
          - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
          - POSTGRES_DB=${POSTGRES_DB}
        volumes:
          - postgres_data:/var/lib/postgresql/data
        networks:
          - portfolio-network

    networks:
      portfolio-network:
        driver: bridge

    volumes:
      postgres_data:
    ```

4.  **Start the Application:**
    ```bash
    docker-compose up -d
    ```

5.  **Access the Dashboard:**
    Open [http://localhost:3000](http://localhost:3000).
    -   **Default Admin Credentials**: `admin` / (The password configured in `.env`)

---

### Option 2: Docker (Build from Source)

If you want to modify the code or build the image yourself.

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd ascend
    ```

2.  **Configure Environment:**
    ```bash
    cp env.example .env
    ```
    *Update `.env` with your preferred credentials if needed.*

3.  **Run with Docker Compose:**
    ```bash
    docker-compose up -d --build
    ```

---

### Option 3: Local Installation

For development or running without Docker.

**Prerequisites:**
-   [Node.js](https://nodejs.org/) (v18 or higher)
-   [PostgreSQL](https://www.postgresql.org/) database

**Steps:**

1.  **Clone and Install Dependencies:**
    ```bash
    git clone <your-repo-url>
    cd ascend
    npm install
    ```

2.  **Configure Environment:**
    ```bash
    cp env.example .env
    ```
    Update `.env` with your local PostgreSQL credentials.

3.  **Setup Database:**
    ```bash
    npx prisma migrate dev
    npx prisma db seed
    ```

4.  **Start the Development Server:**
    ```bash
    npm run dev
    ```

## Tech Stack

-   **Framework**: [Next.js](https://nextjs.org/) (App Router)
-   **Database**: PostgreSQL with [Prisma ORM](https://www.prisma.io/)
-   **Styling**: CSS Modules
-   **Charts**: Recharts & Chart.js
-   **Authentication**: NextAuth.js
-   **AI Integration**: Google Gemini, OpenAI, Anthropic Claude

## Acknowledgments

This project makes use of the following open-source libraries:

-   [Next.js](https://nextjs.org/) - The React Framework for the Web
-   [React](https://react.dev/) - The library for web and native user interfaces
-   [Prisma](https://www.prisma.io/) - Next-generation Node.js and TypeScript ORM
-   [NextAuth.js](https://next-auth.js.org/) - Authentication for Next.js
-   [Chart.js](https://www.chartjs.org/) - Simple yet flexible JavaScript charting for designers & developers
-   [Recharts](https://recharts.org/) - Redefined chart library built with React and D3
-   [Framer Motion](https://www.framer.com/motion/) - A production-ready motion library for React
-   [Lucide React](https://lucide.dev/) - Beautiful & consistent icon toolkit made by the community
-   [date-fns](https://date-fns.org/) - Modern JavaScript date utility library
-   [yahoo-finance2](https://github.com/gadicc/node-yahoo-finance2) - Yahoo Finance API wrapper
-   [react-icons](https://react-icons.github.io/react-icons/) - Include popular icons in your React projects easily

## License

MIT License

Copyright (c) 2025 rajatpatel92

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
