import { describe, expect, test } from "bun:test"
import type { ProjectEntry } from "@/lib/api/types"
import type { DesktopSettings } from "@/lib/desktop"
import { createProjectIdFromPath } from "@/lib/projectId"
import { useProjectsStore } from "./useProjectsStore"

// Settings snapshots are sanitized on the way in, which derives ids from paths.
const entry = (path: string, label: string): ProjectEntry =>
  ({ id: createProjectIdFromPath(path), path, label }) as ProjectEntry

describe("useProjectsStore settings synchronization", () => {
  test("changes only the active pointer for an id-only switch", () => {
    const first = {
      id: "project-a",
      path: "/repo-a",
      label: "Repo A",
      lastOpenedAt: 100,
    } as ProjectEntry
    const second = {
      id: "project-b",
      path: "/repo-b",
      label: "Repo B",
      lastOpenedAt: 200,
    } as ProjectEntry
    const projects = [first, second]
    useProjectsStore.setState({
      projects,
      activeProjectId: first.id,
      manualProjectOrder: [first.id, second.id],
    })

    useProjectsStore.getState().setActiveProjectIdOnly(second.id)

    const state = useProjectsStore.getState()
    expect(state.activeProjectId).toBe(second.id)
    expect(state.projects).toBe(projects)
    expect(state.projects[0]).toBe(first)
    expect(state.projects[1]).toBe(second)
    expect(state.projects[1]?.lastOpenedAt).toBe(200)
  })

  test("treats a successful empty project snapshot as authoritative", () => {
    const project = { id: "project-a", path: "/repo", label: "Repo" } as ProjectEntry
    useProjectsStore.setState({
      projects: [project],
      activeProjectId: project.id,
      manualProjectOrder: [project.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({ projects: [] } as DesktopSettings)

    expect(useProjectsStore.getState().projects).toEqual([])
    expect(useProjectsStore.getState().activeProjectId).toBe(null)
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([])
  })

  test("adopts the server folder order over a stale local manual order", () => {
    const first = entry("/repo-a", "Repo A")
    const second = entry("/repo-b", "Repo B")
    const third = entry("/repo-c", "Repo C")
    useProjectsStore.setState({
      projects: [first, second, third],
      activeProjectId: first.id,
      manualProjectOrder: [first.id, second.id, third.id],
    })

    // Another client reordered the folders and closed one.
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [third, first],
      activeProjectId: first.id,
    } as DesktopSettings)

    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([third.id, first.id])
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([third.id, first.id])
  })

  test("repairs a stale manual order even when the folder list already matches", () => {
    const first = entry("/repo-a", "Repo A")
    const second = entry("/repo-b", "Repo B")
    useProjectsStore.getState().synchronizeFromSettings({
      projects: [second, first],
      activeProjectId: first.id,
    } as DesktopSettings)
    const projects = useProjectsStore.getState().projects
    useProjectsStore.setState({ manualProjectOrder: [first.id, second.id] })

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [second, first],
      activeProjectId: first.id,
    } as DesktopSettings)

    expect(useProjectsStore.getState().manualProjectOrder).toEqual([second.id, first.id])
    // Unchanged folders keep their identity: no unrelated re-render.
    expect(useProjectsStore.getState().projects).toBe(projects)
  })

  test("keeps the open folder when a refresh carries no active pointer", () => {
    const first = entry("/repo-a", "Repo A")
    const second = entry("/repo-b", "Repo B")
    const added = entry("/repo-c", "Repo C")
    useProjectsStore.setState({
      projects: [first, second],
      activeProjectId: second.id,
      manualProjectOrder: [first.id, second.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({ projects: [added, first, second] } as DesktopSettings)

    expect(useProjectsStore.getState().activeProjectId).toBe(second.id)
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([added.id, first.id, second.id])
  })

  test("clears the open folder when a refresh shows it was closed elsewhere", () => {
    const first = entry("/repo-a", "Repo A")
    const second = entry("/repo-b", "Repo B")
    useProjectsStore.setState({
      projects: [first, second],
      activeProjectId: second.id,
      manualProjectOrder: [first.id, second.id],
    })

    useProjectsStore.getState().synchronizeFromSettings({ projects: [first] } as DesktopSettings)

    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([first.id])
    expect(useProjectsStore.getState().activeProjectId).toBe(null)
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([first.id])
  })

  test("reorders folders by index and keeps the manual order in step", () => {
    const first = entry("/repo-a", "Repo A")
    const second = entry("/repo-b", "Repo B")
    const third = entry("/repo-c", "Repo C")
    useProjectsStore.setState({
      projects: [first, second, third],
      activeProjectId: first.id,
      manualProjectOrder: [],
    })

    useProjectsStore.getState().reorderProjects(2, 0)
    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([third.id, first.id, second.id])
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([third.id, first.id, second.id])

    // Out-of-range and no-op moves leave the order untouched.
    useProjectsStore.getState().reorderProjects(0, 5)
    useProjectsStore.getState().reorderProjects(1, 1)
    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([third.id, first.id, second.id])
  })

  test("does not restore paths from the previous runtime during a switch", () => {
    const project = { id: "windows-project", path: "C:/Users/ryder/project", label: "Old host" } as ProjectEntry
    useProjectsStore.setState({
      projects: [project],
      activeProjectId: project.id,
      manualProjectOrder: [project.id],
    })

    useProjectsStore.getState().resetForRuntimeSwitch()

    expect(useProjectsStore.getState().projects).toEqual([])
    expect(useProjectsStore.getState().activeProjectId).toBe(null)
    expect(useProjectsStore.getState().manualProjectOrder).toEqual([])
  })
})
