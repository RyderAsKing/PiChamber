import { ProjectEditDialog } from '@/components/layout/ProjectEditDialog';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import type { ProjectEntry } from '@/lib/api/types';
import type { UpdateInfo, UpdateProgress } from '@/lib/desktop';
import {
  BulkSessionDeleteConfirmDialog,
  FolderDeleteConfirmDialog,
  SessionDeleteConfirmDialog,
  type BulkDeleteSessionsConfirmState,
  type DeleteFolderConfirmState,
  type DeleteSessionConfirmState,
} from './ConfirmDialogs';

export interface SidebarDialogsUpdateStore {
  info: UpdateInfo | null;
  downloading: boolean;
  downloaded: boolean;
  progress: UpdateProgress | null;
  error: string | null;
  downloadUpdate: () => Promise<void>;
  restartToUpdate: () => Promise<void>;
  runtimeType: 'web' | 'desktop' | 'mobile' | null;
}

export interface SidebarDialogsProps {
  updateDialogOpen: boolean;
  setUpdateDialogOpen: (open: boolean) => void;
  updateStore: SidebarDialogsUpdateStore;
  editingProject: ProjectEntry | null;
  setEditingProjectDialogId: (id: string | null) => void;
  handleSaveProjectEdit: (data: { label: string; defaultModel: string | null }) => void;
  deleteSessionConfirm: DeleteSessionConfirmState;
  setDeleteSessionConfirm: (state: DeleteSessionConfirmState) => void;
  showDeletionDialog: boolean;
  setShowDeletionDialog: (show: boolean) => void;
  confirmDeleteSession: () => void;
  deleteFolderConfirm: DeleteFolderConfirmState;
  setDeleteFolderConfirm: (state: DeleteFolderConfirmState) => void;
  confirmDeleteFolder: () => void;
  bulkDeleteConfirm: BulkDeleteSessionsConfirmState;
  setBulkDeleteConfirm: (state: BulkDeleteSessionsConfirmState) => void;
  confirmBulkDelete: () => void;
}

export const SidebarDialogs: React.FC<SidebarDialogsProps> = ({
  updateDialogOpen,
  setUpdateDialogOpen,
  updateStore,
  editingProject,
  setEditingProjectDialogId,
  handleSaveProjectEdit,
  deleteSessionConfirm,
  setDeleteSessionConfirm,
  showDeletionDialog,
  setShowDeletionDialog,
  confirmDeleteSession,
  deleteFolderConfirm,
  setDeleteFolderConfirm,
  confirmDeleteFolder,
  bulkDeleteConfirm,
  setBulkDeleteConfirm,
  confirmBulkDelete,
}) => {
  return (
    <>
      <UpdateDialog
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        info={updateStore.info}
        downloading={updateStore.downloading}
        downloaded={updateStore.downloaded}
        progress={updateStore.progress}
        error={updateStore.error}
        onDownload={updateStore.downloadUpdate}
        onRestart={updateStore.restartToUpdate}
        runtimeType={updateStore.runtimeType}
      />

      <ProjectEditDialog
        open={Boolean(editingProject)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingProjectDialogId(null);
          }
        }}
        project={editingProject}
        onSave={handleSaveProjectEdit}
      />

      <SessionDeleteConfirmDialog
        value={deleteSessionConfirm}
        setValue={setDeleteSessionConfirm}
        showDeletionDialog={showDeletionDialog}
        setShowDeletionDialog={setShowDeletionDialog}
        onConfirm={confirmDeleteSession}
      />

      <FolderDeleteConfirmDialog
        value={deleteFolderConfirm}
        setValue={setDeleteFolderConfirm}
        onConfirm={confirmDeleteFolder}
      />

      <BulkSessionDeleteConfirmDialog
        value={bulkDeleteConfirm}
        setValue={setBulkDeleteConfirm}
        showDeletionDialog={showDeletionDialog}
        setShowDeletionDialog={setShowDeletionDialog}
        onConfirm={confirmBulkDelete}
      />
    </>
  );
};
