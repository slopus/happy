import { Ionicons, Octicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect, useRoute } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import * as React from "react";
import {
	ActivityIndicator,
	Dimensions,
	FlatList,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	TextInput,
	View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
	ContextMenu,
	ContextMenuAction,
	useContextMenu,
} from "@/components/ContextMenu";
import { FileIcon } from "@/components/FileIcon";
import { Item } from "@/components/Item";
import { ItemList } from "@/components/ItemList";
import { layout } from "@/components/layout";
import { SimpleSyntaxHighlighter } from "@/components/SimpleSyntaxHighlighter";
import { Text } from "@/components/StyledText";
import { Typography } from "@/constants/Typography";
import { sessionReadFile } from "@/sync/ops";
import { FileItem, searchFiles } from "@/sync/suggestionFile";

interface FolderStructure {
	[key: string]: {
		files: FileItem[];
		folders: FolderStructure;
	};
}

// File extensions that support syntax highlighting
const SUPPORTED_FILE_EXTENSIONS = new Set([
	"js",
	"jsx",
	"ts",
	"tsx",
	"py",
	"java",
	"c",
	"cpp",
	"h",
	"hpp",
	"cs",
	"php",
	"rb",
	"go",
	"rs",
	"swift",
	"kt",
	"scala",
	"dart",
	"json",
	"xml",
	"html",
	"css",
	"scss",
	"sass",
	"less",
	"md",
	"yml",
	"yaml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"sql",
	"sh",
	"bash",
]);

// File extensions for text preview (no syntax highlighting)
const TEXT_FILE_EXTENSIONS = new Set([
	"txt",
	"log",
	"conf",
	"cfg",
	"ini",
	"env",
	"gitignore",
	"gitattributes",
	"dockerfile",
	"makefile",
	"readme",
	"license",
	"changelog",
]);

const MAX_PREVIEW_SIZE = 100000; // 100KB limit for file preview
const MAX_RECENT_FILES = 10; // Maximum number of recent files to track
const RECENT_FILES_STORAGE_KEY = "repository_recent_files";
const VIRTUALIZATION_THRESHOLD = 100; // Use FlatList when more than 100 items

interface FilePreviewProps {
	visible: boolean;
	file: FileItem | null;
	sessionId: string;
	onClose: () => void;
}

function FilePreviewModal({
	visible,
	file,
	sessionId,
	onClose,
}: FilePreviewProps) {
	const [fileContent, setFileContent] = React.useState<string>("");
	const [isLoading, setIsLoading] = React.useState(false);
	const [error, setError] = React.useState<string>("");
	const { theme } = useUnistyles();

	// Load file content when modal opens
	React.useEffect(() => {
		if (visible && file) {
			loadFileContent();
		}
	}, [visible, file]);

	const loadFileContent = async () => {
		if (!file) return;

		setIsLoading(true);
		setError("");
		setFileContent("");

		try {
			const response = await sessionReadFile(sessionId, file.fullPath);

			if (!response.success) {
				setError(response.error || "Failed to read file");
				return;
			}

			// Decode base64 content
			const decodedContent = response.content ? atob(response.content) : "";

			// Check file size
			if (decodedContent && decodedContent.length > MAX_PREVIEW_SIZE) {
				setError(
					`File too large for preview (${Math.round(decodedContent.length / 1000)}KB). Maximum size: ${MAX_PREVIEW_SIZE / 1000}KB`,
				);
				return;
			}

			setFileContent(decodedContent);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load file");
		} finally {
			setIsLoading(false);
		}
	};

	const getFileLanguage = (fileName: string): string | null => {
		const extension = fileName.split(".").pop()?.toLowerCase();
		if (!extension) return null;

		// Map extensions to language identifiers
		const languageMap: Record<string, string> = {
			js: "javascript",
			jsx: "javascript",
			ts: "typescript",
			tsx: "typescript",
			py: "python",
			java: "java",
			c: "c",
			cpp: "cpp",
			cc: "cpp",
			cxx: "cpp",
			h: "c",
			hpp: "cpp",
			cs: "csharp",
			php: "php",
			rb: "ruby",
			go: "go",
			rs: "rust",
			swift: "swift",
			kt: "kotlin",
			scala: "scala",
			dart: "dart",
			json: "json",
			xml: "xml",
			html: "html",
			css: "css",
			scss: "scss",
			sass: "sass",
			less: "less",
			md: "markdown",
			yml: "yaml",
			yaml: "yaml",
			sql: "sql",
			sh: "bash",
			bash: "bash",
		};

		return languageMap[extension] || null;
	};

	const shouldShowSyntaxHighlighting = (fileName: string): boolean => {
		const extension = fileName.split(".").pop()?.toLowerCase();
		return extension ? SUPPORTED_FILE_EXTENSIONS.has(extension) : false;
	};

	const isTextFile = (fileName: string): boolean => {
		const extension = fileName.split(".").pop()?.toLowerCase();
		return extension
			? SUPPORTED_FILE_EXTENSIONS.has(extension) ||
					TEXT_FILE_EXTENSIONS.has(extension)
			: false;
	};

	if (!visible || !file) return null;

	return (
		<Modal
			visible={visible}
			animationType="slide"
			presentationStyle="pageSheet"
			onRequestClose={onClose}
		>
			<View
				style={[
					styles.previewContainer,
					{ backgroundColor: theme.colors.surface },
				]}
			>
				{/* Header */}
				<View
					style={[
						styles.previewHeader,
						{ borderBottomColor: theme.colors.divider },
					]}
				>
					<View style={styles.previewHeaderContent}>
						<View style={styles.previewTitleContainer}>
							<FileIcon fileName={file.fileName} size={24} />
							<View style={styles.previewTitleText}>
								<Text
									style={[styles.previewTitle, { color: theme.colors.text }]}
								>
									{file.fileName}
								</Text>
								<Text
									style={[
										styles.previewSubtitle,
										{ color: theme.colors.textSecondary },
									]}
								>
									{file.filePath || "Root"}
								</Text>
							</View>
						</View>
						<Pressable
							onPress={onClose}
							style={styles.closeButton}
							hitSlop={15}
						>
							<Ionicons name="close" size={24} color={theme.colors.text} />
						</Pressable>
					</View>
				</View>

				{/* Content */}
				<ScrollView style={styles.previewContent}>
					{isLoading ? (
						<View style={styles.previewLoadingContainer}>
							<ActivityIndicator
								size="small"
								color={theme.colors.textSecondary}
							/>
							<Text
								style={[
									styles.previewLoadingText,
									{ color: theme.colors.textSecondary },
								]}
							>
								Loading file...
							</Text>
						</View>
					) : error ? (
						<View style={styles.previewErrorContainer}>
							<Octicons
								name="alert"
								size={48}
								color={theme.colors.textSecondary}
							/>
							<Text
								style={[
									styles.previewErrorText,
									{ color: theme.colors.textSecondary },
								]}
							>
								{error}
							</Text>
						</View>
					) : !isTextFile(file.fileName) ? (
						<View style={styles.previewErrorContainer}>
							<Octicons
								name="file-binary"
								size={48}
								color={theme.colors.textSecondary}
							/>
							<Text
								style={[
									styles.previewErrorText,
									{ color: theme.colors.textSecondary },
								]}
							>
								Binary file - preview not available
							</Text>
							<Text
								style={[
									styles.previewErrorSubtext,
									{ color: theme.colors.textSecondary },
								]}
							>
								Tap the back button and select "Open in file viewer" for full
								functionality
							</Text>
						</View>
					) : fileContent ? (
						<View style={styles.previewCodeContainer}>
							{shouldShowSyntaxHighlighting(file.fileName) ? (
								<SimpleSyntaxHighlighter
									code={fileContent}
									language={getFileLanguage(file.fileName)}
									selectable={true}
								/>
							) : (
								<Text
									style={[
										styles.previewPlainText,
										{ color: theme.colors.text },
									]}
									selectable={true}
								>
									{fileContent}
								</Text>
							)}
						</View>
					) : (
						<View style={styles.previewErrorContainer}>
							<Octicons
								name="file"
								size={48}
								color={theme.colors.textSecondary}
							/>
							<Text
								style={[
									styles.previewErrorText,
									{ color: theme.colors.textSecondary },
								]}
							>
								Empty file
							</Text>
						</View>
					)}
				</ScrollView>
			</View>
		</Modal>
	);
}

export default function RepositoryScreen() {
	const route = useRoute();
	const router = useRouter();
	const sessionId = (route.params! as any).id as string;

	const [allFiles, setAllFiles] = React.useState<FileItem[]>([]);
	const [currentPath, setCurrentPath] = React.useState<string>("");
	const [isLoading, setIsLoading] = React.useState(true);
	const [searchQuery, setSearchQuery] = React.useState("");
	const [filteredItems, setFilteredItems] = React.useState<FileItem[]>([]);
	const [previewFile, setPreviewFile] = React.useState<FileItem | null>(null);
	const [showPreview, setShowPreview] = React.useState(false);
	const [recentFiles, setRecentFiles] = React.useState<FileItem[]>([]);
	const [selectedIndex, setSelectedIndex] = React.useState<number>(-1);
	const [debouncedSearchQuery, setDebouncedSearchQuery] = React.useState("");
	const [contextMenuFile, setContextMenuFile] = React.useState<FileItem | null>(
		null,
	);
	const contextMenu = useContextMenu();
	const { theme } = useUnistyles();

	// Load recent files from storage
	React.useEffect(() => {
		const loadRecentFiles = async () => {
			try {
				const stored = await AsyncStorage.getItem(
					`${RECENT_FILES_STORAGE_KEY}_${sessionId}`,
				);
				if (stored) {
					const parsed = JSON.parse(stored);
					setRecentFiles(parsed);
				}
			} catch (error) {
				console.error("Failed to load recent files:", error);
			}
		};
		loadRecentFiles();
	}, [sessionId]);

	// Add file to recent files
	const addToRecentFiles = React.useCallback(
		(file: FileItem) => {
			setRecentFiles((prev) => {
				// Remove file if it already exists
				const filtered = prev.filter((f) => f.fullPath !== file.fullPath);
				// Add to beginning
				const updated = [file, ...filtered].slice(0, MAX_RECENT_FILES);

				// Save to AsyncStorage
				try {
					AsyncStorage.setItem(
						`${RECENT_FILES_STORAGE_KEY}_${sessionId}`,
						JSON.stringify(updated),
					);
				} catch (error) {
					console.error("Failed to save recent files:", error);
				}

				return updated;
			});
		},
		[sessionId],
	);

	// Debounce search query for performance
	React.useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedSearchQuery(searchQuery);
		}, 300); // 300ms debounce

		return () => clearTimeout(timer);
	}, [searchQuery]);

	// Build folder structure from flat file list
	const buildFolderStructure = React.useCallback(
		(files: FileItem[]): FolderStructure => {
			const structure: FolderStructure = {};

			files.forEach((file) => {
				const pathParts = file.fullPath
					.split("/")
					.filter((part) => part.length > 0);
				let current = structure;

				// Navigate to the correct folder in the structure
				for (let i = 0; i < pathParts.length - 1; i++) {
					const part = pathParts[i];
					if (!current[part]) {
						current[part] = { files: [], folders: {} };
					}
					current = current[part].folders;
				}

				// Add the file to the appropriate folder
				const finalPart = pathParts[pathParts.length - 1];
				if (file.fileType === "folder") {
					if (!current[finalPart]) {
						current[finalPart] = { files: [], folders: {} };
					}
				} else {
					const parentKey =
						pathParts.length > 1 ? pathParts[pathParts.length - 2] : "";
					if (parentKey) {
						if (!current[parentKey]) {
							current[parentKey] = { files: [], folders: {} };
						}
						current[parentKey].files.push(file);
					} else {
						// Root level file
						if (!current[""]) {
							current[""] = { files: [], folders: {} };
						}
						current[""].files.push(file);
					}
				}
			});

			return structure;
		},
		[],
	);

	// Get current folder items based on current path
	const getCurrentFolderItems = React.useCallback(
		(files: FileItem[], path: string, searchTerm: string): FileItem[] => {
			if (searchTerm) {
				// When searching, show all matching files
				return files.filter(
					(file) =>
						file.fileName.toLowerCase().includes(searchTerm.toLowerCase()) ||
						file.fullPath.toLowerCase().includes(searchTerm.toLowerCase()),
				);
			}

			if (path === "") {
				// Root level - show immediate children only
				return files.filter((file) => {
					const pathParts = file.fullPath
						.split("/")
						.filter((part) => part.length > 0);
					return (
						pathParts.length === 1 ||
						(pathParts.length === 2 && file.fileType === "folder")
					);
				});
			} else {
				// Show items in the current folder
				const pathPrefix = path.endsWith("/") ? path : path + "/";
				return files.filter((file) => {
					if (file.fullPath === path) return false; // Don't show the current folder itself

					if (file.fullPath.startsWith(pathPrefix)) {
						// Check if this is a direct child (not nested deeper)
						const relativePath = file.fullPath.substring(pathPrefix.length);
						const relativeParts = relativePath
							.split("/")
							.filter((part) => part.length > 0);
						return (
							relativeParts.length === 1 ||
							(relativeParts.length === 2 &&
								file.fileType === "folder" &&
								relativePath.endsWith("/"))
						);
					}
					return false;
				});
			}
		},
		[],
	);

	// Load all files from the session
	const loadFiles = React.useCallback(async () => {
		try {
			setIsLoading(true);
			const files = await searchFiles(sessionId, "", { limit: 5000 });
			setAllFiles(files);
		} catch (error) {
			console.error("Failed to load repository files:", error);
			setAllFiles([]);
		} finally {
			setIsLoading(false);
		}
	}, [sessionId]);

	// Update filtered items when files, path, or debounced search query change
	React.useEffect(() => {
		if (allFiles.length > 0) {
			const items = getCurrentFolderItems(
				allFiles,
				currentPath,
				debouncedSearchQuery,
			);
			setFilteredItems(items);
			setSelectedIndex(-1); // Reset selection when items change
		}
	}, [allFiles, currentPath, debouncedSearchQuery, getCurrentFolderItems]);

	// Load files on mount and when screen is focused
	React.useEffect(() => {
		loadFiles();
	}, [loadFiles]);

	useFocusEffect(
		React.useCallback(() => {
			loadFiles();
		}, [loadFiles]),
	);

	// Handle item press (navigate into folder or preview file)
	const handleItemPress = React.useCallback(
		(item: FileItem) => {
			if (item.fileType === "folder") {
				// Navigate into folder
				setCurrentPath(item.fullPath);
				setSearchQuery(""); // Clear search when navigating
			} else {
				// Add to recent files and show preview
				addToRecentFiles(item);
				setPreviewFile(item);
				setShowPreview(true);
			}
		},
		[addToRecentFiles],
	);

	// Handle opening file in full viewer
	const handleOpenInViewer = React.useCallback(
		(item: FileItem) => {
			addToRecentFiles(item);
			const encodedPath = btoa(item.fullPath);
			router.push(`/session/${sessionId}/file?path=${encodedPath}`);
		},
		[router, sessionId, addToRecentFiles],
	);

	// Close file preview
	const handleClosePreview = React.useCallback(() => {
		setShowPreview(false);
		setPreviewFile(null);
	}, []);

	// Handle long press for context menu
	const handleItemLongPress = React.useCallback(
		(item: FileItem) => () => {
			if (item.fileType === "folder") return; // Only show context menu for files

			setContextMenuFile(item);

			// Default position for mobile (centered)
			const screenWidth = Dimensions.get("window").width;
			const position = { x: screenWidth / 2 - 125, y: 200 };

			contextMenu.show(position);
		},
		[contextMenu],
	);

	// Context menu actions
	const contextMenuActions = React.useMemo((): ContextMenuAction[] => {
		if (!contextMenuFile) return [];

		return [
			{
				id: "preview",
				title: "Preview File",
				icon: "eye-outline",
				onPress: () => {
					addToRecentFiles(contextMenuFile);
					setPreviewFile(contextMenuFile);
					setShowPreview(true);
				},
			},
			{
				id: "open",
				title: "Open in File Viewer",
				icon: "open-outline",
				onPress: () => handleOpenInViewer(contextMenuFile),
			},
			{
				id: "copy-path",
				title: "Copy File Path",
				icon: "copy-outline",
				onPress: async () => {
					try {
						await Clipboard.setStringAsync(contextMenuFile.fullPath);
						// Could show a toast here
					} catch (error) {
						console.error("Failed to copy path:", error);
					}
				},
			},
			{
				id: "copy-name",
				title: "Copy File Name",
				icon: "document-outline",
				onPress: async () => {
					try {
						await Clipboard.setStringAsync(contextMenuFile.fileName);
						// Could show a toast here
					} catch (error) {
						console.error("Failed to copy name:", error);
					}
				},
			},
		];
	}, [contextMenuFile, addToRecentFiles, handleOpenInViewer]);

	// Close context menu
	const handleCloseContextMenu = React.useCallback(() => {
		contextMenu.hide();
		setContextMenuFile(null);
	}, [contextMenu]);

	// Keyboard navigation support (mainly for web)
	React.useEffect(() => {
		if (Platform.OS !== "web") return;

		const handleKeyDown = (event: KeyboardEvent) => {
			// Only handle keyboard if no modal is open and we have items
			if (showPreview || filteredItems.length === 0) return;

			switch (event.key) {
				case "ArrowDown":
					event.preventDefault();
					setSelectedIndex((prev) =>
						prev < filteredItems.length - 1 ? prev + 1 : prev,
					);
					break;

				case "ArrowUp":
					event.preventDefault();
					setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
					break;

				case "Enter":
					event.preventDefault();
					if (selectedIndex >= 0 && selectedIndex < filteredItems.length) {
						handleItemPress(filteredItems[selectedIndex]);
					}
					break;

				case "Escape":
					event.preventDefault();
					if (currentPath !== "") {
						// Go back to parent folder
						const parentPath = currentPath.split("/").slice(0, -1).join("/");
						setCurrentPath(parentPath);
						setSearchQuery("");
					} else if (searchQuery) {
						// Clear search
						setSearchQuery("");
					}
					break;

				case "Backspace":
					if (!searchQuery && currentPath !== "") {
						event.preventDefault();
						// Go back to parent folder
						const parentPath = currentPath.split("/").slice(0, -1).join("/");
						setCurrentPath(parentPath);
					}
					break;
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [
		filteredItems,
		selectedIndex,
		showPreview,
		currentPath,
		searchQuery,
		handleItemPress,
	]);

	// Generate breadcrumbs for navigation
	const breadcrumbs = React.useMemo(() => {
		if (currentPath === "") return [{ name: "Root", path: "" }];

		const parts = currentPath.split("/").filter((part) => part.length > 0);
		const crumbs = [{ name: "Root", path: "" }];

		let accumulatedPath = "";
		parts.forEach((part) => {
			accumulatedPath += part + "/";
			crumbs.push({ name: part, path: accumulatedPath });
		});

		return crumbs;
	}, [currentPath]);

	// Navigate to specific breadcrumb
	const handleBreadcrumbPress = React.useCallback((path: string) => {
		setCurrentPath(path);
		setSearchQuery("");
	}, []);

	// Render breadcrumb navigation
	const renderBreadcrumbs = () => (
		<View style={styles.breadcrumbContainer}>
			{breadcrumbs.map((crumb, index) => (
				<React.Fragment key={crumb.path}>
					<Text
						style={[
							styles.breadcrumb,
							index === breadcrumbs.length - 1 && styles.breadcrumbActive,
						]}
						onPress={() => handleBreadcrumbPress(crumb.path)}
					>
						{crumb.name}
					</Text>
					{index < breadcrumbs.length - 1 && (
						<Text style={styles.breadcrumbSeparator}> / </Text>
					)}
				</React.Fragment>
			))}
		</View>
	);

	// Render file/folder icon - memoized for performance
	const renderItemIcon = React.useCallback((item: FileItem) => {
		if (item.fileType === "folder") {
			return <Octicons name="file-directory" size={29} color="#007AFF" />;
		}
		return <FileIcon fileName={item.fileName} size={29} />;
	}, []);

	// Render subtitle with item type and path info - memoized for performance
	const renderItemSubtitle = React.useCallback(
		(item: FileItem) => {
			if (debouncedSearchQuery) {
				// Show full path when searching
				return item.filePath || "Root";
			}

			if (item.fileType === "folder") {
				return "Folder";
			}

			// For files, show just the immediate parent folder
			const pathParts = item.fullPath
				.split("/")
				.filter((part) => part.length > 0);
			if (pathParts.length > 1) {
				return pathParts[pathParts.length - 2];
			}
			return "Root";
		},
		[debouncedSearchQuery],
	);

	// Memoized render function for file items
	const renderFileItem = React.useCallback(
		({ item, index }: { item: FileItem; index: number }) => (
			<Item
				title={item.fileName.replace(/\/$/, "")} // Remove trailing slash for folders
				subtitle={renderItemSubtitle(item)}
				icon={renderItemIcon(item)}
				onPress={() => handleItemPress(item)}
				onLongPress={
					item.fileType === "file" ? handleItemLongPress(item) : undefined
				}
				showDivider={index < filteredItems.length - 1}
				selected={Platform.OS === "web" && selectedIndex === index}
				style={
					Platform.OS === "web" && selectedIndex === index
						? { backgroundColor: theme.colors.input.background }
						: undefined
				}
			/>
		),
		[
			renderItemSubtitle,
			renderItemIcon,
			handleItemPress,
			handleItemLongPress,
			filteredItems.length,
			selectedIndex,
			theme.colors.input.background,
		],
	);

	// Key extractor for FlatList performance
	const keyExtractor = React.useCallback(
		(item: FileItem, index: number) => `${item.fullPath}-${index}`,
		[],
	);

	return (
		<View style={[styles.container, { backgroundColor: theme.colors.surface }]}>
			{/* Search Input */}
			<View style={styles.searchContainer}>
				<View
					style={[
						styles.searchInputContainer,
						{ backgroundColor: theme.colors.input.background },
					]}
				>
					<Octicons
						name="search"
						size={16}
						color={theme.colors.textSecondary}
						style={{ marginRight: 8 }}
					/>
					<TextInput
						value={searchQuery}
						onChangeText={setSearchQuery}
						placeholder="Search files and folders..."
						style={[styles.searchInput, { color: theme.colors.text }]}
						placeholderTextColor={theme.colors.input.placeholder}
						autoCapitalize="none"
						autoCorrect={false}
					/>
				</View>
			</View>

			{/* Breadcrumb Navigation */}
			{!searchQuery && renderBreadcrumbs()}

			{/* Recent Files Section */}
			{!searchQuery && currentPath === "" && recentFiles.length > 0 && (
				<View style={styles.recentFilesSection}>
					<View
						style={[
							styles.recentFilesHeader,
							{ borderBottomColor: theme.colors.divider },
						]}
					>
						<Octicons
							name="clock"
							size={16}
							color={theme.colors.textSecondary}
						/>
						<Text
							style={[styles.recentFilesTitle, { color: theme.colors.text }]}
						>
							Recent Files
						</Text>
					</View>
					{recentFiles.slice(0, 5).map((file, index) => (
						<Item
							key={`recent-${file.fullPath}-${index}`}
							title={file.fileName}
							subtitle={`${file.filePath || "Root"} • Recently accessed`}
							icon={
								<Octicons
									name="history"
									size={24}
									color={theme.colors.textSecondary}
								/>
							}
							onPress={() => handleItemPress(file)}
							onLongPress={
								file.fileType === "file" ? handleItemLongPress(file) : undefined
							}
							showDivider={index < Math.min(recentFiles.length, 5) - 1}
						/>
					))}
				</View>
			)}

			{/* File List */}
			<ItemList style={{ flex: 1 }}>
				{isLoading ? (
					<View style={styles.loadingContainer}>
						<ActivityIndicator
							size="small"
							color={theme.colors.textSecondary}
						/>
						<Text
							style={[
								styles.loadingText,
								{ color: theme.colors.textSecondary },
							]}
						>
							Loading repository...
						</Text>
					</View>
				) : filteredItems.length === 0 ? (
					<View style={styles.emptyContainer}>
						<Octicons
							name={searchQuery ? "search" : "file-directory"}
							size={48}
							color={theme.colors.textSecondary}
						/>
						<Text
							style={[styles.emptyText, { color: theme.colors.textSecondary }]}
						>
							{searchQuery ? "No files found" : "No files in this folder"}
						</Text>
						{searchQuery && (
							<Text
								style={[
									styles.emptySubtext,
									{ color: theme.colors.textSecondary },
								]}
							>
								Try a different search term
							</Text>
						)}
					</View>
				) : (
					<>
						{searchQuery && (
							<View
								style={[
									styles.searchResultsHeader,
									{ backgroundColor: theme.colors.surfaceHigh },
								]}
							>
								<Text
									style={[
										styles.searchResultsText,
										{ color: theme.colors.textLink },
									]}
								>
									{filteredItems.length} results for "{searchQuery}"
								</Text>
							</View>
						)}
						{filteredItems.length > VIRTUALIZATION_THRESHOLD ? (
							<FlatList
								data={filteredItems}
								renderItem={renderFileItem}
								keyExtractor={keyExtractor}
								removeClippedSubviews={true}
								maxToRenderPerBatch={20}
								updateCellsBatchingPeriod={50}
								initialNumToRender={20}
								windowSize={10}
								getItemLayout={
									Platform.OS === "ios"
										? (data, index) => ({
												length: 60, // Approximate item height
												offset: 60 * index,
												index,
											})
										: undefined
								}
								style={styles.flatList}
							/>
						) : (
							filteredItems.map((item, index) => (
								<Item
									key={`${item.fullPath}-${index}`}
									title={item.fileName.replace(/\/$/, "")} // Remove trailing slash for folders
									subtitle={renderItemSubtitle(item)}
									icon={renderItemIcon(item)}
									onPress={() => handleItemPress(item)}
									onLongPress={
										item.fileType === "file"
											? handleItemLongPress(item)
											: undefined
									}
									showDivider={index < filteredItems.length - 1}
									selected={Platform.OS === "web" && selectedIndex === index}
									style={
										Platform.OS === "web" && selectedIndex === index
											? { backgroundColor: theme.colors.input.background }
											: undefined
									}
								/>
							))
						)}
					</>
				)}
			</ItemList>

			{/* File Preview Modal */}
			<FilePreviewModal
				visible={showPreview}
				file={previewFile}
				sessionId={sessionId}
				onClose={handleClosePreview}
			/>

			{/* Context Menu */}
			<ContextMenu
				visible={contextMenu.visible}
				onClose={handleCloseContextMenu}
				actions={contextMenuActions}
				anchorPosition={contextMenu.anchorPosition}
				title={contextMenuFile?.fileName}
			/>
		</View>
	);
}

const styles = StyleSheet.create((theme) => ({
	container: {
		flex: 1,
		maxWidth: layout.maxWidth,
		alignSelf: "center",
		width: "100%",
	},
	searchContainer: {
		padding: 16,
		borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
		borderBottomColor: theme.colors.divider,
	},
	searchInputContainer: {
		flexDirection: "row",
		alignItems: "center",
		borderRadius: 10,
		paddingHorizontal: 12,
		paddingVertical: 8,
	},
	searchInput: {
		flex: 1,
		fontSize: 16,
		...Typography.default(),
	},
	breadcrumbContainer: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
		borderBottomColor: theme.colors.divider,
		flexWrap: "wrap",
	},
	breadcrumb: {
		fontSize: 14,
		color: theme.colors.textLink,
		...Typography.default(),
	},
	breadcrumbActive: {
		color: theme.colors.text,
		fontWeight: "600",
	},
	breadcrumbSeparator: {
		fontSize: 14,
		color: theme.colors.textSecondary,
		...Typography.default(),
	},
	loadingContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		paddingTop: 40,
	},
	loadingText: {
		fontSize: 16,
		textAlign: "center",
		marginTop: 16,
		...Typography.default(),
	},
	emptyContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		paddingTop: 40,
		paddingHorizontal: 20,
	},
	emptyText: {
		fontSize: 16,
		textAlign: "center",
		marginTop: 16,
		...Typography.default(),
	},
	emptySubtext: {
		fontSize: 14,
		textAlign: "center",
		marginTop: 8,
		...Typography.default(),
	},
	searchResultsHeader: {
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
		borderBottomColor: theme.colors.divider,
	},
	searchResultsText: {
		fontSize: 14,
		fontWeight: "600",
		...Typography.default(),
	},
	recentFilesSection: {
		marginBottom: 8,
	},
	recentFilesHeader: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
		gap: 8,
	},
	recentFilesTitle: {
		fontSize: 14,
		fontWeight: "600",
		...Typography.default("semiBold"),
	},
	flatList: {
		flex: 1,
	},
	// File Preview Modal Styles
	previewContainer: {
		flex: 1,
	},
	previewHeader: {
		borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
		paddingTop: Platform.select({ ios: 60, default: 20 }),
		paddingBottom: 16,
	},
	previewHeaderContent: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
	},
	previewTitleContainer: {
		flexDirection: "row",
		alignItems: "center",
		flex: 1,
	},
	previewTitleText: {
		marginLeft: 12,
		flex: 1,
	},
	previewTitle: {
		fontSize: 18,
		fontWeight: "600",
		...Typography.default("semiBold"),
	},
	previewSubtitle: {
		fontSize: 14,
		marginTop: 2,
		...Typography.default(),
	},
	closeButton: {
		padding: 8,
	},
	previewContent: {
		flex: 1,
	},
	previewLoadingContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		paddingTop: 60,
	},
	previewLoadingText: {
		fontSize: 16,
		textAlign: "center",
		marginTop: 16,
		...Typography.default(),
	},
	previewErrorContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		paddingTop: 60,
		paddingHorizontal: 40,
	},
	previewErrorText: {
		fontSize: 16,
		textAlign: "center",
		marginTop: 16,
		...Typography.default(),
	},
	previewErrorSubtext: {
		fontSize: 14,
		textAlign: "center",
		marginTop: 8,
		...Typography.default(),
	},
	previewCodeContainer: {
		padding: 16,
	},
	previewPlainText: {
		fontSize: 14,
		lineHeight: 20,
		...Typography.mono(),
	},
}));
