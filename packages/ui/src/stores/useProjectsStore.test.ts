import { describe, expect, test } from "bun:test"
import type { ProjectEntry } from "@/lib/api/types"
import type { DesktopSettings } from "@/lib/desktop"
import { createProjectIdFromPath } from "@/lib/projectId"
import { useProjectsStore } from "./useProjectsStore"

describe("useProjectsStore settings synchronization", () => {
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

  test("merges remote projects without stealing a valid local selection", () => {
    const desktopId = createProjectIdFromPath("/repo/desktop")
    const mobileId = createProjectIdFromPath("/repo/mobile")
    useProjectsStore.setState({
      projects: [{ id: desktopId, path: "/repo/desktop" }],
      activeProjectId: desktopId,
      manualProjectOrder: [],
    })

    useProjectsStore.getState().synchronizeFromSettings({
      projects: [
        { id: desktopId, path: "/repo/desktop" },
        { id: mobileId, path: "/repo/mobile" },
      ],
      activeProjectId: mobileId,
    } as DesktopSettings)

    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([desktopId, mobileId])
    expect(useProjectsStore.getState().activeProjectId).toBe(desktopId)
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
