#!/usr/bin/env python3
import subprocess
import sys
import time

def run_git_cmd(cmd):
    """Helper to run git commands and return output."""
    try:
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"Error running {' '.join(cmd)}: {e.stderr.strip()}")
        return None

def get_remote_branches_modified_recently():
    """Finds remote branches modified in the last 48 hours."""
    cmd = [
        "git", "for-each-ref", 
        "--sort=-committerdate", 
        "--format=%(refname:short)|%(committerdate:unix)", 
        "refs/remotes/fork"
    ]
    output = run_git_cmd(cmd)
    if not output:
        return []

    now = time.time()
    forty_eight_hours_ago = now - (48 * 3600)
    
    recent_branches = []
    for line in output.split("\n"):
        if not line or "|" not in line:
            continue
        branch, timestamp_str = line.split("|")
        try:
            timestamp = int(timestamp_str)
            if timestamp >= forty_eight_hours_ago:
                recent_branches.append(branch)
        except ValueError:
            continue
            
    return recent_branches

def get_truly_new_commits(remote_branch):
    """
    Uses 'git cherry' to find commits on the remote branch that do not 
    exist on HEAD by equivalent patch ID (ignoring different hashes).
    """
    # git cherry HEAD remote_branch outputs lines like:
    # + d1c4b3... (Commit is unique to remote)
    # - a3f2b1... (Commit equivalent already exists in HEAD)
    cmd = ["git", "cherry", "HEAD", remote_branch]
    output = run_git_cmd(cmd)
    if not output:
        return []
    
    unique_commits = []
    for line in output.split("\n"):
        if line.startswith("+ "):
            # Extract just the commit hash
            unique_commits.append(line.split(" ")[1])
            
    return unique_commits

def main():
    print("Fetching latest from remote...")
    run_git_cmd(["git", "fetch", "fork"])

    print("Checking for remote branches modified in the last 48 hours...")
    remote_branches = get_remote_branches_modified_recently()
    
    if not remote_branches:
        print("No remote branches found modified in the last 48 hours.")
        return

    for branch in remote_branches:
        commits = get_truly_new_commits(branch)
        if not commits:
            # All changes are already present on HEAD, despite hash differences
            continue

        print(f"\nBranch '{branch}' has {len(commits)} unique commit(s) not in your current branch.")
        
        # Display the specific commits that will be cherry-picked
        for commit in commits:
            commit_info = run_git_cmd(["git", "log", "-1", "--oneline", commit])
            print(f"  {commit_info}")

        choice = input(f"Do you want to cherry-pick these {len(commits)} commit(s)? (y/n): ").strip().lower()
        if choice in ['y', 'yes']:
            print(f"Cherry-picking commits from {branch}...")
            for commit in commits:
                print(f"Cherry-picking {commit[:7]}...")
                try:
                    subprocess.run(["git", "cherry-pick", commit], check=True)
                except subprocess.CalledProcessError:
                    print("\n[ERROR] Cherry-pick conflict or failure detected.")
                    print("Please resolve manually in your terminal, then resume.")
                    sys.exit(1)
        else:
            print(f"Skipped {branch}.")

if __name__ == "__main__":
    main()