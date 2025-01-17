// Rate limiting setup
class RateLimiter {
    constructor(maxRequests, perMinutes = 1) {
        this.maxRequests = maxRequests;
        this.perMinutes = perMinutes;
        this.requests = [];
    }

    async waitForAvailableSlot() {
        const now = Date.now();
        const windowMs = this.perMinutes * 60 * 1000;
        this.requests = this.requests.filter(time => now - time < windowMs);

        if (this.requests.length >= this.maxRequests) {
            const oldestRequest = this.requests[0];
            const waitTime = (oldestRequest + windowMs) - now;
            console.log(`Rate limit reached. Waiting ${Math.ceil(waitTime / 1000)} seconds...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return this.waitForAvailableSlot();
        }

        this.requests.push(now);
    }
}

// Create rate limiter: 12 requests per minute
const rateLimiter = new RateLimiter(12, 1);

// Utility function for rate-limited fetch
async function rateLimitedFetch(url, options) {
    await rateLimiter.waitForAvailableSlot();
    const response = await fetch(url, options);
    
    if (response.status === 429) {
        console.error('Rate limit exceeded despite our precautions');
        throw new Error('Rate limit exceeded');
    }
    
    return response;
}

// Extract task information from element
function extractTaskInfo(taskElement) {
    // Try to get direct task ID first
    const eventId = taskElement.getAttribute('data-event-id');
    const [prefix, id] = eventId ? eventId.split('|') : [];

    // For task name, we need to handle the structure more carefully
    // Looking at the DOM, the actual task name is in a span with overflow-hidden
    const taskSpan = taskElement.querySelector('.overflow-hidden.text-ellipsis');
    const taskName = taskSpan ? taskSpan.textContent.trim() : '';

    // Check if this is a split task by looking for fraction indicators
    const fractionElement = taskElement.querySelector('sup');
    const isSplitTask = !!fractionElement;

    console.log('Task Info:', {
        calendarId: prefix === 'task' ? id : null,
        taskName,
        isSplitTask,
        eventId,
        hasFraction: !!fractionElement,
        rawHTML: taskElement.innerHTML // For debugging
    });
    
    return {
        calendarId: prefix === 'task' ? id : null,
        taskName,
        isSplitTask
    };
}

// Find matching task in our API data
function findMatchingTask(taskInfo, tasksData) {
    // First try direct ID match
    const directMatch = tasksData.find(task => task.id === taskInfo.calendarId);
    if (directMatch) {
        console.log('Found direct match:', directMatch);
        return directMatch;
    }
    
    // If it's a split task and we have a task name, try matching by name
    if (taskInfo.isSplitTask && taskInfo.taskName) {
        const nameMatch = tasksData.find(task => 
            task.name.toLowerCase() === taskInfo.taskName.toLowerCase()
        );
        if (nameMatch) {
            console.log('Found split task match by name:', nameMatch);
            return nameMatch;
        }
    }
    
    console.log('No match found for task:', taskInfo);
    return null;
}

function addDaysUntilDue(taskElement, dueDate) {
    // Remove any existing days-until-due elements
    const existing = taskElement.querySelector('[data-days-until-due]');
    if (existing) existing.remove();

    const days = Math.floor((new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24));
    
    let status, color;
    if (days < 0) {
        status = 'Overdue';
        color = '#ef4444';
    } else if (days === 0) {
        status = 'Due today';
        color = '#f97316';
    } else if (days === 1) {
        status = 'Tomorrow';
        color = '#facc15';
    } else {
        status = `${days}d`;
        color = days <= 3 ? '#facc15' : days <= 7 ? '#60a5fa' : '#4ade80';
    }

    // Find the container where we want to add our element
    const container = taskElement.querySelector('.fc-event-main') || taskElement;
    
    const dueElement = document.createElement('div');
    dueElement.setAttribute('data-days-until-due', 'true');
    dueElement.style.cssText = `
        position: absolute;
        right: 6px;
        bottom: 3px;
        background: rgba(0, 0, 0, 0.04);
        color: ${color};
        padding: 2px 6px;
        border-radius: 3px;
        font-size: 11px;
        font-weight: 600;
        z-index: 1000;
        line-height: 13px;
        pointer-events: none;
        backdrop-filter: blur(2px);
        white-space: nowrap;
    `;
    
    dueElement.textContent = status;

    // Ensure the container has relative positioning
    container.style.position = 'relative';
    container.appendChild(dueElement);
}

// Function to fetch all tasks for a workspace using pagination
async function fetchAllTasksForWorkspace(workspaceId, apiKey) {
    let allTasks = [];
    let nextCursor = null;
    let pageCount = 1;
    const MAX_RETRIES = 3;
    let retryCount = 0;

    do {
        try {
            console.log(`Fetching page ${pageCount} of tasks for workspace ${workspaceId}...`);
            
            const tasksUrl = new URL('https://api.usemotion.com/v1/tasks');
            tasksUrl.searchParams.append('workspaceId', workspaceId);
            if (nextCursor) {
                tasksUrl.searchParams.append('cursor', nextCursor);
            }
            
            const tasksResponse = await rateLimitedFetch(tasksUrl, {
                headers: {
                    'Accept': 'application/json',
                    'X-API-Key': apiKey
                }
            });

            if (!tasksResponse.ok) {
                if (tasksResponse.status === 429) {
                    // Specific handling for rate limit
                    if (retryCount < MAX_RETRIES) {
                        retryCount++;
                        console.warn(`Rate limit hit. Retry ${retryCount}...`);
                        await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
                        continue;
                    } else {
                        console.error('Maximum retries reached for rate limit');
                        break;
                    }
                }
                console.error(`Failed to fetch tasks page ${pageCount}: ${tasksResponse.status}`);
                break;
            }

            const tasksData = await tasksResponse.json();
            allTasks = allTasks.concat(tasksData.tasks);
            nextCursor = tasksData.meta.nextCursor;
            pageCount++;
            retryCount = 0; // Reset retry count on successful fetch
            
        } catch (error) {
            console.error('Error fetching tasks:', error);
            if (retryCount < MAX_RETRIES) {
                retryCount++;
                console.warn(`Retry ${retryCount} after error...`);
                await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
            } else {
                console.error('Maximum retries reached');
                break;
            }
        }
    } while (nextCursor);

    console.log(`Total tasks fetched for workspace: ${allTasks.length}`);
    return allTasks;
}

//process tasks and add visual elements
function processAllTasks(tasksData) {
    const taskElements = document.querySelectorAll('[data-event-id^="task|"]');
    taskElements.forEach(element => {
        processTaskElement(element, tasksData);
    });
}


// Process a single task element
async function processTaskElement(taskElement, tasksData) {
    const taskInfo = extractTaskInfo(taskElement);
    if (!taskInfo.calendarId && !taskInfo.taskName) return;

    const matchingTask = findMatchingTask(taskInfo, tasksData);
    if (!matchingTask || !matchingTask.dueDate) return;

    // Add the due date indicator to the task element
    addDaysUntilDue(taskElement, matchingTask.dueDate);
}

// Set up observer for dynamically loaded tasks
function setupTaskObserver(tasksData) {
    const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    // Check if the node itself is a task
                    if (node.matches('[data-event-id^="task|"]')) {
                        console.log('Observer: Found new task element directly');
                        processTaskElement(node, tasksData);
                    } else {
                        // Check for tasks within the added node
                        const tasks = node.querySelectorAll('[data-event-id^="task|"]');
                        if (tasks.length > 0) {
                            console.log('Observer: Found new tasks within element:', tasks.length);
                            tasks.forEach(task => processTaskElement(task, tasksData));
                        }
                    }
                }
            });
            
            // Also check for attribute changes on existing tasks
            if (mutation.type === 'attributes' && 
                mutation.attributeName === 'data-event-id' &&
                mutation.target.matches('[data-event-id^="task|"]')) {
                console.log('Observer: Task attribute changed');
                processTaskElement(mutation.target, tasksData);
            }
        });
    });

    // Configure the observer
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-event-id']
    });

    console.log('Task observer setup complete');
    return observer;
}

// Main function to fetch workspaces and their tasks
async function fetchMotionData(apiKey) {
    try {
        // 1. Fetch workspaces
        console.log('Fetching workspaces...');
        const workspacesResponse = await rateLimitedFetch('https://api.usemotion.com/v1/workspaces', {
            headers: {
                'Accept': 'application/json',
                'X-API-Key': apiKey
            }
        });

        if (!workspacesResponse.ok) {
            throw new Error(`Workspaces fetch failed: ${workspacesResponse.status}`);
        }

        const workspacesData = await workspacesResponse.json();
        console.log('Raw workspaces response:', workspacesData);

        // 2. Fetch all tasks for each workspace
        let allTasks = [];
        for (const workspace of workspacesData.workspaces) {
            console.log(`\nFetching ALL tasks for workspace: ${workspace.name} (${workspace.id})`);
            const tasks = await fetchAllTasksForWorkspace(workspace.id, apiKey);
            allTasks = allTasks.concat(tasks);
        }

        // 3. Process tasks and set up observers
        processAllTasks(allTasks);
        const observer = setupTaskObserver(allTasks);
        
        // Cleanup on page unload
        window.addEventListener('unload', () => observer.disconnect(), { once: true });
        
    } catch (error) {
        console.error('Error fetching Motion data:', error);
    }
}

// Initialize when the script loads
console.log('Motion Task Extension loaded');

// Get API key from storage and start fetching data
chrome.storage.sync.get(['motionApiKey'], async function(result) {
    if (!result.motionApiKey) {
        console.log('API key not found. Please set it in the extension options.');
        return;
    }

    // Start fetching data
    await fetchMotionData(result.motionApiKey);
});