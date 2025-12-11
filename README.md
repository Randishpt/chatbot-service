# Smart Inventory Chatbot Service

![Node.js](https://img.shields.io/badge/Node.js-v14%2B-green)
![Express.js](https://img.shields.io/badge/Express.js-4.x-blue)
![Groq API](https://img.shields.io/badge/AI-Groq%20Whisper%20%26%20Llama-orange)

A powerful, AI-driven inventory management chatbot service designed to facilitate seamless interaction between users and inventory systems. This service leverages the **Groq Cloud API** for ultra-fast text inference and **Whisper** for state-of-the-art voice transcription, integrated with Microservice Context Protocol (MCP) services for real-time stock querying and order processing.

## 🚀 Key Features

-   **🎙️ Voice-to-Text Support**: Send voice notes and have them instantly transcribed and processed using Groq Whisper.
-   **🛒 Intelligent Cart System**: Context-aware shopping cart that manages multiple items, calculates subtotals, and generates receipts.
-   **🔍 Real-time Stock Checking**: Connects with **MCP A** to verify product availability instantly.
-   **📦 Automated Ordering**: Seamlessly places orders via **MCP B** once the user confirms their purchase.
-   **🧠 Contextual Conversations**: Remembers conversation history for a natural, human-like chatting experience.
-   **⚡ High Performance**: Built on Express.js with optimized audio processing and cleanup.

## 🛠️ Architecture

```mermaid
graph LR
    User[User / Client App] <-->|Voice/Text| Chatbot[Chatbot Service]
    Chatbot <-->|Inference| Groq[Groq Cloud API]
    Chatbot <-->|Query Stock| MCPA[MCP A (Inventory)]
    Chatbot <-->|Place Order| MCPB[MCP B (Orders)]
```

## 📋 Prerequisites

Before you begin, ensure you have the following installed:

-   **Node.js** (v14 or higher)
-   **npm** (Node Package Manager)
-   **Groq API Key**: Obtain one from the [Groq Console](https://console.groq.com/keys).

## 🔧 Installation

To run the full system, you need to set up the Chatbot Service alongside its two microservices.

1.  **Clone the repositories**:
    It is recommended to clone these into the same parent directory.

    ```bash
    # 1. Chatbot Service (Main Interface)
    # If you haven't already:
    # git clone <your-chatbot-repo-url>
    
    # 2. MCP A (Inventory/Query Service)
    git clone https://github.com/Randishpt/mcp-a.git
    
    # 3. MCP B (Order/Modify Service)
    git clone https://github.com/Randishpt/mcp-b.git
    ```

2.  **Install Dependencies**:
    You must install dependencies for **all three** services.

    ```bash
    # For Chatbot Service
    cd chatbot-service
    npm install
    
    # For MCP A
    cd ../mcp-a
    npm install
    
    # For MCP B
    cd ../mcp-b
    npm install
    ```

## ⚙️ Configuration

1.  **Environment Setup**:
    Copy the example environment file to create your own configuration.
    ```bash
    cp .env.example .env
    ```

2.  **Edit `.env`**:
    Open the `.env` file and configure your credentials:
    ```env
    PORT=3004
    GROQ_API_KEY=your_actual_api_key_here
    MCP_A_URL=http://localhost:3001
    MCP_B_URL=http://localhost:3002
    ```

## 🚀 Usage

### Development Mode
Run the server with hot-reloading (requires `nodemon`):
```bash
npm run dev
```

### Production Mode
Start the standard Node.js server:
```bash
npm start
```

The service will start on **http://localhost:3004** (or your specified PORT).

## 📡 API Reference

### 1. Chat Endpoint
Process a text message from the user.

-   **Endpoint**: `POST /api/chat`
-   **Reference**: [server.js](file:///e:/test 3/easyrent/chatbot-service/server.js)
-   **Body**:
    ```json
    {
      "message": "Cek stok laptop"
    }
    ```
-   **Response**:
    ```json
    {
      "response": "Stok laptop saat ini tersedia 50 unit."
    }
    ```

### 2. Voice Transcription Endpoint
Upload an audio file for transcription and immediate processing.

-   **Endpoint**: `POST /api/transcribe`
-   **Reference**: [server.js](file:///e:/test 3/easyrent/chatbot-service/server.js)
-   **Headers**: `Content-Type: multipart/form-data`
-   **Body**: form-data with key `audio` (file).
-   **Response**:
    ```json
    {
      "transcription": "Saya mau pesan 2 buku",
      "response": "Baik, 2 buku telah ditambahkan ke keranjang..."
    }
    ```

## 📂 Project Structure

-   `server.js`: Main application entry point and logic.
-   `compressAudio.js`: Helper module for audio compression.
-   `uploads/`: Temporary directory for processing audio files.
-   `public/`: Static files for the web interface.

## 📄 License

This project is licensed under the MIT License.
