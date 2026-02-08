import { BrowserRouter, Route, Routes } from "react-router-dom"
import ProjectListPage from "./pages/ProjectListPage"
import ProjectChatPage from "./pages/ProjectChatPage"
import "./App.css"

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProjectListPage />} />
        <Route path="/project/:projectId" element={<ProjectChatPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
