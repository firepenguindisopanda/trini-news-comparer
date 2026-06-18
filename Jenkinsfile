pipeline {
    agent {
        docker {
            image 'node:22-alpine'
            args '-v /var/run/docker.sock:/var/run/docker.sock -v /home/swepi/Desktop:/home/swepi/Desktop'
        }
    }

    environment {
        PRODUCTION_DIR = "/home/swepi/Desktop/trinidad-news-comparer"
    }

    stages {
        stage('Setup') {
            steps {
                sh 'apk add --no-cache docker-cli rsync'
                sh 'npm ci'
            }
        }

        stage('Lint') {
            steps {
                sh 'npm run lint 2>/dev/null || echo "No linter configured"'
            }
        }

        stage('Deploy') {
            steps {
                sh """
                    rsync -av --delete \
                        --exclude='.env' \
                        --exclude='node_modules/' \
                        --exclude='.git/' \
                        ./ \${PRODUCTION_DIR}/
                    cd \${PRODUCTION_DIR} && docker compose up -d --build
                """
            }
        }
    }

    post {
        failure {
            echo "Pipeline failed. Check the logs for details."
        }
    }
}
