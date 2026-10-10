import { createBrowserRouter, Navigate } from "react-router";
import { Layout } from "./components/Layout.tsx";
import { BookPage } from "./pages/BookPage.tsx";
import { PairPage } from "./pages/PairPage.tsx";
import { ProjectPage } from "./pages/ProjectPage.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "projects/:pid/:section?", element: <ProjectPage /> },
      { path: "projects/:pid/pairs/:pairId/:stage?", element: <PairPage /> },
      { path: "projects/:pid/books/:bookId/:stage?", element: <BookPage /> },
      { path: "settings/:section?", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/projects" replace /> },
    ],
  },
]);
